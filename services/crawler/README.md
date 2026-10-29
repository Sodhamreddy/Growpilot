# Crawler service

Headless Chromium rendering, for the pages the native crawler cannot read.

The TypeScript crawler in `packages/seo` handles everything normal: robots.txt,
sitemaps, SSRF guards, page budgets, politeness, page-type priority. It reads
HTML as sent, which is right for most sites and wrong for two cases:

- pages that render their content with JavaScript
- hosts that gate every visitor behind a "checking your browser" interstitial

Neither is reachable without a browser engine. No HTTP client solves it —
Scrapy, requests and curl all get the same 403 our crawler does.

## Running it

```bash
cd services/crawler
python -m venv .venv
.venv/Scripts/activate        # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
python -m playwright install chromium
python app.py
```

Listens on `127.0.0.1:8787`. Set `CRAWLER_SERVICE_URL` in the root `.env` to
point the worker at it.

## When it is not running

Nothing breaks. The worker treats it as optional: a normal crawl never touches
it, and a JS-blocked crawl fails with the same clear message it gives today.
Starting the service turns that failure into a successful render; stopping it
turns it back. No configuration change either way.

## Scope

This service fetches and renders. It does not decide what to crawl, does not
parse business facts, and holds no state. Every policy decision stays in
`@ob/seo` — duplicating robots and SSRF rules across two languages would mean
maintaining two copies of the rules that decide what we may fetch, and living
with them disagreeing.

The one exception is the SSRF check, which is deliberately implemented in both
places: this service listens on a port, so anything that can reach it can ask it
to fetch a URL. A guard that only exists in the caller is not a guard.

## Network boundary

Browser HTTP requests, including redirects and subresources, are intercepted and fetched with `network.PublicResolver`, which checks all DNS answers and returns the checked addresses for the connection. Literal IPs are checked separately. Responses are limited to 5 MiB and 30 seconds. WebSockets are closed, and a local deny proxy prevents browser requests that bypass interception from reaching arbitrary destinations. Keep this service private; it is not an authenticated public API.

Run network regression tests with `python -m unittest test_network.py` from this directory. These tests use mocked DNS and do not contact external websites.
