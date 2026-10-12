"""
Reading a business's reviews from its public Google Maps page.

The fallback for when neither Google API is available: no Places key, no
Business Profile approval. It opens the listing the way a person would, sorts
the reviews newest first, scrolls to load them, and reads what is on screen.

Two cautions this file is written around:

  - Automated access to Maps is against Google's terms. It is used here only
    for a listing its owner pointed us at, slowly, at most once a day per
    business, and the dashboard prefers either API as soon as one exists.
  - Maps markup is unversioned and changes without notice. Every selector has
    a fallback by role or label, every field is optional, and a page that
    yields nothing is reported as "could not read", never as zero reviews.

Only Google Maps addresses are opened, so this endpoint cannot be used to make
the service fetch anything else.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from playwright.async_api import Browser, Page, async_playwright

# Hosts a Maps link may use. Short links redirect to google.com/maps.
_ALLOWED = re.compile(
    r"^(?:www\.)?google\.[a-z.]{2,6}$|^maps\.google\.[a-z.]{2,6}$|^maps\.app\.goo\.gl$|^goo\.gl$"
)
_BLOCKED_PAGE = re.compile(r"unusual traffic|/sorry/|recaptcha|detected unusual", re.I)

_playwright = None
_browser: Browser | None = None
_lock = asyncio.Lock()


def is_maps_url(url: str) -> bool:
    p = urlparse(url.strip())
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    host = p.hostname.lower()
    if not _ALLOWED.match(host):
        return False
    if host == "goo.gl":
        return p.path.startswith("/maps")
    if host.endswith("goo.gl"):
        return True
    return p.path.startswith("/maps") or host.startswith("maps.")


async def _get_browser() -> Browser:
    global _playwright, _browser
    async with _lock:
        if _browser is None or not _browser.is_connected():
            _playwright = _playwright or await async_playwright().start()
            _browser = await _playwright.chromium.launch(headless=True)
        return _browser


async def close_browser() -> None:
    global _playwright, _browser
    if _browser is not None:
        await _browser.close()
        _browser = None
    if _playwright is not None:
        await _playwright.stop()
        _playwright = None


def _english(url: str) -> str:
    """The same page in English, so labels and relative dates can be read."""
    p = urlparse(url)
    q = dict(parse_qsl(p.query))
    q["hl"] = "en"
    return urlunparse(p._replace(query=urlencode(q)))


_UNITS = {"minute": 1 / 1440, "hour": 1 / 24, "day": 1, "week": 7, "month": 30, "year": 365}


def relative_to_date(text: str, now: datetime | None = None) -> datetime | None:
    """'3 weeks ago' → an approximate date. Maps shows only relative dates."""
    now = now or datetime.now(timezone.utc)
    t = text.lower().replace("edited", "").strip()
    m = re.search(r"(a|an|\d+)\s+(minute|hour|day|week|month|year)s?\s+ago", t)
    if not m:
        return None
    n = 1 if m.group(1) in ("a", "an") else int(m.group(1))
    return now - timedelta(days=n * _UNITS[m.group(2)])


# Runs inside the page. Class names are Maps' current ones; roles and labels
# are the fallbacks that survive a redesign longer.
_EXTRACT_JS = r"""
() => {
  const q = (el, ...sels) => { for (const s of sels) { const f = el.querySelector(s); if (f) return f; } return null; };
  const title = (q(document, 'h1.DUwDvf', 'h1') || {}).textContent || null;
  let rating = null, count = null;
  const summary = q(document, 'div.F7nice', 'span.ceNzKf', '[role="img"][aria-label*="stars"]');
  if (summary) {
    const txt = (summary.textContent || summary.getAttribute('aria-label') || '').replace(/,/g, '');
    const r = txt.match(/(\d(?:\.\d)?)/); if (r) rating = parseFloat(r[1]);
    const c = txt.match(/\((\d+)\)/) || txt.match(/(\d+)\s+reviews?/i); if (c) count = parseInt(c[1], 10);
  }
  if (count === null) {
    for (const el of document.querySelectorAll('button, span, div.fontBodySmall')) {
      const t = (el.getAttribute('aria-label') || el.textContent || '').trim();
      const c = t.match(/^([\d,.]+)\s+reviews?$/i);
      if (c) { count = parseInt(c[1].replace(/[,.]/g, ''), 10); break; }
    }
  }
  const reviews = [...document.querySelectorAll('div[data-review-id].jftiEf, div.jftiEf[data-review-id], div[data-review-id][aria-label]')]
    .filter((el, i, all) => all.findIndex((o) => o.getAttribute('data-review-id') === el.getAttribute('data-review-id')) === i)
    .map((el) => {
      const starsEl = q(el, 'span.kvMYJc', '[role="img"][aria-label*="star"]');
      const stars = starsEl ? parseInt(((starsEl.getAttribute('aria-label') || '').match(/(\d)/) || [])[1] || '0', 10) : 0;
      const textEl = q(el, 'span.wiI7pd', '.MyEned span');
      const reply = q(el, 'div.CDe7pd .wiI7pd', 'div.CDe7pd');
      const photo = q(el, 'img.NBa7we', 'button img');
      const author = q(el, 'button.WEBjve', 'button[data-href*="contrib"]');
      return {
        id: el.getAttribute('data-review-id'),
        author: (q(el, '.d4r55', '[class*="d4r55"]') || {}).textContent || el.getAttribute('aria-label') || '',
        authorUrl: author ? author.getAttribute('data-href') : null,
        photo: photo ? photo.getAttribute('src') : null,
        stars,
        when: (q(el, 'span.rsqaWe', '.DU9Pgb span') || {}).textContent || '',
        text: textEl ? textEl.textContent : null,
        reply: reply ? reply.textContent : null,
      };
    });
  return { title, rating, count, reviews };
}
"""


async def _accept_consent(page: Page) -> None:
    """The EU cookie wall, when Google shows one."""
    if "consent." not in page.url:
        return
    for label in ("Reject all", "Accept all"):
        btn = page.get_by_role("button", name=label)
        if await btn.count():
            await btn.first.click()
            await page.wait_for_load_state("domcontentloaded")
            return


async def read_reviews(url: str, limit: int = 50, timeout_ms: int = 45_000) -> dict[str, Any]:
    """Open the listing and read up to `limit` newest reviews."""
    browser = await _get_browser()
    context = await browser.new_context(
        locale="en-US",
        viewport={"width": 1280, "height": 900},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    )
    page = await context.new_page()
    page.set_default_timeout(timeout_ms)
    try:
        await page.goto(url, wait_until="domcontentloaded")
        await _accept_consent(page)
        # Short links resolve to the full address; reload it in English.
        if "hl=en" not in page.url:
            await page.goto(_english(page.url), wait_until="domcontentloaded")
            await _accept_consent(page)

        if _BLOCKED_PAGE.search(page.url) or _BLOCKED_PAGE.search(await page.content()):
            return {"blocked": True, "error": "Google is showing a traffic check instead of the listing. Try again later."}

        try:
            await page.wait_for_selector("h1", timeout=20_000)
        except Exception:  # noqa: BLE001
            return {"error": "That link does not open a single business on Google Maps. Open the business on Maps and copy the link from Share."}

        # A search result list rather than one place.
        if await page.locator('div[role="feed"]').count() and not await page.locator("h1.DUwDvf").count():
            return {"error": "That link shows a list of places. Open the business itself on Maps and copy its link."}

        place = await page.evaluate(_EXTRACT_JS)
        panel = page.locator("div.m6QErb.DxyBCb").first

        async def scroll_panel() -> None:
            if await panel.count():
                await panel.evaluate("(el) => el.scrollBy(0, el.scrollHeight)")
            else:
                await page.mouse.wheel(0, 4000)
            await page.wait_for_timeout(900)

        # Full view has a Reviews tab. Signed-out visitors get Google's
        # "limited view", where the reviews sit lower on the overview and only
        # load once scrolled to; both end at the same "Sort reviews" control.
        tab = page.locator('button[role="tab"][aria-label^="Reviews"], button[role="tab"]:has-text("Reviews")')
        if await tab.count():
            await tab.first.click()
            await page.wait_for_timeout(1500)
        sort = page.locator('button[aria-label="Sort reviews"], button[aria-label*="Sort reviews"]')
        for _ in range(12):
            if await sort.count():
                break
            await scroll_panel()

        if not await sort.count() and not await page.locator("div[data-review-id]").count():
            data = await page.evaluate(_EXTRACT_JS)
            return {**data, "url": page.url, "reviews": [], "note": "No reviews were found on this listing."}

        # Newest first, so a limited read gets the reviews that need replies.
        if await sort.count():
            try:
                await sort.first.click()
                await page.locator('[role="menuitemradio"]:has-text("Newest")').first.click(timeout=3_000)
                await page.wait_for_timeout(2000)
            except Exception:  # noqa: BLE001 — limited view has no sort menu; keep Google's order
                await page.keyboard.press("Escape")

        # Scroll until enough are loaded or no more arrive.
        seen, still = 0, 0
        for _ in range(40):
            count = await page.locator("div[data-review-id].jftiEf, div.jftiEf").count()
            if count >= limit:
                break
            still = still + 1 if count == seen else 0
            if still >= 3:
                break
            seen = count
            await scroll_panel()

        # Expand truncated reviews ("More").
        for button in await page.locator('div.jftiEf button.w8nwRe, div.jftiEf button[aria-label="See more"]').all():
            try:
                await button.click(timeout=1_000)
            except Exception:  # noqa: BLE001
                pass

        data = await page.evaluate(_EXTRACT_JS)
        now = datetime.now(timezone.utc)
        reviews = []
        for r in data.get("reviews", [])[:limit]:
            if not r.get("id") or not r.get("stars"):
                continue
            published = relative_to_date(r.get("when") or "", now)
            reviews.append({
                "id": r["id"],
                "author": (r.get("author") or "").strip() or "A Google user",
                "authorUrl": r.get("authorUrl"),
                "photo": r.get("photo"),
                "rating": r["stars"],
                "text": (r.get("text") or "").strip() or None,
                "reply": (r.get("reply") or "").strip() or None,
                "when": (r.get("when") or "").strip(),
                "publishedAt": published.isoformat() if published else None,
            })
        return {
            "title": (place.get("title") or data.get("title") or "").strip() or None,
            "rating": place.get("rating") if place.get("rating") is not None else data.get("rating"),
            "count": data.get("count") or place.get("count"),
            # Signed-out visitors see Google's "limited view": a handful of reviews, no sorting.
            "limited": "limited view" in (await page.inner_text("body")).lower(),
            "url": page.url,
            "reviews": reviews,
        }
    finally:
        await context.close()
