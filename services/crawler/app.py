"""
Crawl4AI rendering service.

A small HTTP wrapper around Crawl4AI, which drives a headless Chromium. It
exists for one reason the TypeScript crawler cannot cover: sites that render
their content with JavaScript, or that gate every visitor behind a "checking
your browser" interstitial. Both are invisible to any client that reads HTML as
sent — our own crawler, Scrapy, requests, curl — because none of them run
scripts.

Scope is deliberately narrow. This service fetches and renders; it does not
decide what to crawl, does not parse business facts, and holds no state. Every
policy decision — robots.txt, SSRF checks, page budgets, politeness, page-type
priority — stays in @ob/seo, where it is already implemented and tested. Moving
those here would mean maintaining two copies of the rules that decide whether we
are allowed to fetch something, which is exactly the kind of duplication that
ends with the two disagreeing.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from contextlib import asynccontextmanager
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig

# ── Configuration ───────────────────────────────────────────────────────────

PORT = int(os.environ.get("CRAWLER_SERVICE_PORT", "8787"))
DEFAULT_TIMEOUT_MS = int(os.environ.get("CRAWLER_TIMEOUT_MS", "30000"))
MAX_CONCURRENCY = int(os.environ.get("CRAWLER_CONCURRENCY", "2"))

# One browser for the process lifetime. Chromium takes seconds to start, and
# paying that per request would make the fallback slower than the problem it
# solves.
_crawler: AsyncWebCrawler | None = None
_slots = asyncio.Semaphore(MAX_CONCURRENCY)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _crawler
    _crawler = AsyncWebCrawler(
        config=BrowserConfig(
            headless=True,
            verbose=False,
            # Identify honestly. The bot name and contact stay on the end so an
            # operator reading their access log can see who we are, even though
            # the browser string is what gets us past naive filters.
            user_agent=os.environ.get(
                "CRAWLER_USER_AGENT",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 "
                "GrowPilotBot/0.1 (+https://kleza.io/bot)",
            ),
        )
    )
    await _crawler.start()
    try:
        yield
    finally:
        await _crawler.close()
        _crawler = None


app = FastAPI(title="GrowPilot crawler", version="0.1.0", lifespan=lifespan)


# ── SSRF guard ──────────────────────────────────────────────────────────────

def _is_blocked_ip(raw: str) -> bool:
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return True  # not parseable — refuse
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local      # covers 169.254.169.254, the metadata address
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _assert_public(url: str) -> str | None:
    """Return an error message when the URL must not be fetched.

    Duplicated from the TypeScript crawler on purpose. This service listens on a
    port, and anything that can reach that port can ask it to fetch a URL — so
    it has to refuse internal addresses itself rather than trusting its caller.
    A guard that only exists on the calling side is not a guard.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"Only http and https are allowed, got {parsed.scheme!r}."
    if not parsed.hostname:
        return "That URL has no host."

    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror:
        return "That domain could not be resolved."

    for info in infos:
        if _is_blocked_ip(info[4][0]):
            return "That address is not publicly reachable."
    return None


# ── API ─────────────────────────────────────────────────────────────────────

class RenderRequest(BaseModel):
    url: str
    timeout_ms: int = Field(default=DEFAULT_TIMEOUT_MS, ge=1_000, le=120_000)
    # Some interstitials redirect after a beat. A short settle lets that finish
    # before the HTML is read.
    settle_ms: int = Field(default=600, ge=0, le=15_000)
    wait_for: str | None = None
    """Scroll the page to trigger lazy loading. Off by default — see below."""
    scan_full_page: bool = False


class RenderResponse(BaseModel):
    url: str
    status: int
    html: str
    markdown: str
    text: str
    links: list[str]
    title: str | None
    rendered: Literal[True] = True


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": _crawler is not None,
        "concurrency": MAX_CONCURRENCY,
        "engine": "crawl4ai",
    }


@app.post("/render")
async def render(req: RenderRequest) -> JSONResponse:
    if _crawler is None:
        return JSONResponse({"error": "The browser is not running."}, status_code=503)

    blocked = _assert_public(req.url)
    if blocked:
        return JSONResponse({"error": blocked}, status_code=422)

    run = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        page_timeout=req.timeout_ms,
        delay_before_return_html=req.settle_ms / 1000,
        wait_for=req.wait_for,
        # `scan_full_page` scrolls the whole document to trigger lazy loading.
        # That matters for image galleries and infinite feeds; we extract text,
        # which is in the DOM either way. Leaving it on cost ~8s per page and
        # turned a 40-page crawl into a nine-minute job.
        scan_full_page=req.scan_full_page,
        # Stop at DOM-ready rather than waiting for every last network request.
        # Analytics beacons and chat widgets keep a page "loading" long after
        # its text is final.
        wait_until="domcontentloaded",
        excluded_tags=["script", "style", "noscript", "svg"],
    )

    async with _slots:
        try:
            result = await _crawler.arun(url=req.url, config=run)
        except Exception as exc:  # noqa: BLE001 — surface any driver failure as 502
            return JSONResponse(
                {"error": f"The browser could not load that page: {exc}"},
                status_code=502,
            )

    if not result.success:
        return JSONResponse(
            {"error": result.error_message or "The page could not be rendered."},
            status_code=502,
        )

    markdown = getattr(result, "markdown", "") or ""
    if not isinstance(markdown, str):
        # Newer builds return a MarkdownGenerationResult rather than a string.
        markdown = getattr(markdown, "raw_markdown", "") or ""

    internal = [
        link.get("href", "")
        for link in (result.links or {}).get("internal", [])
        if link.get("href")
    ]

    return JSONResponse(
        RenderResponse(
            url=result.url or req.url,
            status=result.status_code or 200,
            html=result.cleaned_html or result.html or "",
            markdown=markdown,
            text=(result.cleaned_html or "") and markdown or "",
            links=internal,
            title=(result.metadata or {}).get("title"),
        ).model_dump()
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
