# Our Brand Studio — full flow

What happens, in order, from a stranger hitting the sign-in page to a published
article. Written against the code as it stands: every number here was read from
the repository or measured, not recalled.

**Status: 251 tests passing across 19 files. Blog Automation works end to end.
Social Media Timeline and GMB Reviews are scaffolded but not built.**

---

## 1. The shape of it

```
   Browser ──────────► apps/web        (Next.js — UI, API routes, sessions)
                          │
                          │ enqueue
                          ▼
                       Redis           (BullMQ — 7 queues)
                          │
                          │ consume
                          ▼
                    apps/worker        (crawl, extract, research, draft, publish)
                       │      │
              ┌────────┘      └────────┐
              ▼                        ▼
      services/crawler            Gemini API
      (headless Chromium,         (extraction, drafting,
       only when needed)           embeddings)
              │                        │
              └────────┬───────────────┘
                       ▼
                   Supabase            (Postgres 17.6 + pgvector, 25 tables)
```

**The web app never does slow work.** It writes a row, enqueues a job, and
returns. Everything that takes seconds — crawling, model calls, embedding —
happens in the worker. This is why the app stays responsive while a crawl runs,
and why **nothing in the pipeline moves unless the worker is running**. That
single fact accounts for most of the "it's stuck" confusion during development.

---

## 2. Running it

Three processes, three terminals:

```bash
npm run dev                              # web        → localhost:3002
pnpm dev:worker                          # worker     → consumes the queues
cd services/crawler && python app.py     # renderer   → 127.0.0.1:8787  (optional)
```

Redis must be running. Supabase is remote, so nothing to start there.

The renderer is genuinely optional: without it, sites needing a browser report
that they do, and everything else is unaffected.

---

## 3. Sign-up and sign-in

| Route | Does |
|---|---|
| `POST /api/auth/signup` | Creates user + workspace + owner membership in one transaction |
| `POST /api/auth/signin` | Verifies password, issues a session cookie |
| `POST /api/auth/forgot-password` | Mints a reset token (SHA-256 stored, 1 hour, single use) |
| `POST /api/auth/reset-password` | Sets the new password, **destroys every session** |
| `GET /api/auth/google/start` → `/callback` | OIDC with state + nonce, only if configured |

Passwords are scrypt-hashed; sessions are opaque tokens whose SHA-256 is stored,
so a database leak yields no usable sessions.

Two deliberate choices that look like bugs until explained:

- **Sign-up says "That email address cannot be used"** rather than "already
  registered". Confirming which addresses have accounts is a user-enumeration
  endpoint.
- **Resetting a password does not sign you in.** You prove you hold the new
  password by using it; otherwise a forwarded link grants access without the
  password ever being known.

---

## 4. Onboarding

Six steps. Every completed step is POSTed to `/api/onboarding/step` immediately,
so a refresh resumes from the server rather than from memory.

```
01 About you      →  how did you hear about us            (skippable)
02 Your business  →  goals: articles / local / social     (at least one)
03 Your business  →  website URL, or describe it yourself
04 Detecting      →  crawl → extract → voice → index      (worker does this)
05 Confirm        →  review every extracted fact
06 Your setup     →  brand colours, content pillars, platforms
```

Step 3 branches, and the branch matters:

- **Website** — the crawler reads the site. Facts arrive with the page URL and
  the sentence they came from.
- **Describe it myself** — three questions. Skips detection entirely. Correct
  choice when a site blocks crawlers.

**Step 5 is a gate, not a formality.** Generation is blocked until a human
confirms the profile, and confirming marks every extracted fact `verified: true`
— which is what lets drafts state them without hedging.

---

## 5. What the crawler does

`packages/seo` — one external dependency, `cheerio`, for HTML parsing. Node's
built-in `fetch` does the HTTP.

```
robots.txt  →  sitemap.xml  →  link following  →  prioritised fetch
```

- **Honours robots.txt.** `Disallow: /` refuses the crawl rather than ignoring it.
- **Seeds from sitemap.xml** including one level of sitemap-index expansion.
- **Prioritises by page type** — home → services → about → location → contact →
  FAQ → blog → legal. Extraction sees the services page before the blog archive.
- **Paces every request** at 1200 ms, robots.txt and sitemaps included, because
  bot filters count total request rate rather than page rate.
- **Blocks SSRF** — DNS resolved up front, private/loopback/link-local and cloud
  metadata ranges refused, and **every redirect hop re-validated**. A public
  hostname can redirect to `169.254.169.254`.
- **Extracts brand colours** from markup during the crawl, because the stored
  page text has already had style attributes stripped out.

### When a static fetch is not enough

Two cases the fetcher cannot handle, both detected:

| Case | Symptom | Handling |
|---|---|---|
| JS challenge | 403 with "checking your browser" | Retry via `services/crawler` |
| Client-rendered | 200, markup but almost no text | Retry via `services/crawler` |

`services/crawler` is Crawl4AI driving headless Chromium. It renders and returns
HTML; it makes no policy decisions — robots, SSRF, budgets and priority all stay
in `@ob/seo`, so there is one copy of the rules that decide what may be fetched.

Measured on `myassuredhomenursing.com`, which blocks every plain HTTP client:

```
without renderer   0 pages — "checks every visitor with JavaScript"
with renderer      8 pages, 17,387 words
```

**It degrades cleanly.** One 2-second health check per crawl. Service down or
unset, the crawl behaves exactly as it would without it.

---

## 6. What Gemini does

Every model call goes through `@ob/ai`, a provider-neutral gateway: feature code
names a *task*, never a model. Swapping providers touches one file.

| Task alias | Model | Produces |
|---|---|---|
| `structured_json` | `gemini-2.5-flash-lite` | Profile, voice, keywords, topics |
| `reasoning_high` | `gemini-2.5-flash` | Content briefs |
| `writing_long` | `gemini-2.5-flash` | Article drafts |
| `embedding` | `gemini-embedding-001` | 1536-dim vectors |

Real output from a crawl of `myassuredhomenursing.com`:

```
name      : Assured Home Nursing
industry  : Home Health Care
audience  : Seniors and their families
services  : Alzheimer's & Dementia Care · 24 Hour Home Care · Personal Care
            Companion Care · Stroke and Paralysis Care
locations : Birmingham, MI · Novi, MI
voice     : compassionate, caring, supportive · balanced formality
            explanatory · brand-led · warm · consultation CTAs
```

**Gemini cannot fetch URLs.** It analyses text the crawler supplies. Asked to
research a business from search instead, it returned three different phone
numbers and two conflicting addresses — one belonging to a different company.
That is why crawling is the source of truth and search grounding is not used.

---

## 7. The article pipeline

```
topic → brief → draft → 7 quality gates → approval → WordPress
```

Two ways a topic starts:

1. **Suggested** — `POST /api/topics/suggest` asks for five topics grounded in
   services and locations. Suggestions are *not* stored; only an accepted one
   becomes a row. A location the business does not operate in is dropped.
2. **Planned** — keyword research clusters terms and builds a schedule.

### Article states

```
draft ─► generating ─► qa ─┬─► needs_changes ─► generating
                           ├─► awaiting_approval ─► approved ─► scheduled ─► published
                           └─► failed
```

`draft → published` is not in the transition table, so publishing without
approval is not reachable by calling the wrong function in the wrong order.

### The seven gates

`grounding` · `business_facts` · `brand` · `seo` · `risk` · `publishing` · `audit`

A draft that fails any gate goes to `needs_changes` rather than to a person.

---

## 8. Publishing to WordPress

`POST /api/articles/:id/publish` is the strictest route in the codebase:

- admin role required
- `canPublish` re-evaluated against live state, not the caller's belief
- the integration must be connected and unexpired
- idempotency keyed on article **version**, so a double-submit cannot publish twice

The worker then performs the call. Its ordering is deliberate: the job is marked
`running` **before** the external request, so a crash mid-flight leaves evidence
that a post may already exist. A job found `running` refuses to re-run rather
than risk publishing twice.

**Posts land as drafts.** Even a scheduled article is sent as a draft — a
WordPress scheduled post goes live on its own with nobody watching, which defeats
the approval gate. The article is *not* marked `published` when it reaches
WordPress, because it is not public yet; `publishedUrl` records where it went.

---

## 9. Module boundaries

```
@ob/blog  ─┐
@ob/social ├─► @ob/pipeline ─► @ob/ai, @ob/db, @ob/core, @ob/voice, @ob/kb
@ob/gmb   ─┘
```

Nothing horizontal. Each pillar owns its own code:

| Package | Owns |
|---|---|
| `@ob/blog` | trending · keywords · plan · brief · article |
| `@ob/social` | timeline events, calendar slots, per-network limits |
| `@ob/gmb` | reviews, replies, human-only blocklist |
| `@ob/pipeline` | extract · voice · gates · approval · completeness |
| `@ob/publish` | markdown → HTML, WordPress connector |

Approval, gates and brand voice are **shared deliberately**. A blog article, a
social post and a review reply all need approval and all must sound like the same
business; three copies is how three subtly different definitions of "approved"
end up in one product.

This is enforced by a test that reads actual import statements and fails naming
the offending file — not by convention.

Worker processors mirror it: `processors/blog/`, `processors/shared/`, with
`social/` and `gmb/` waiting.

---

## 10. What is not built

| | Needs | Notes |
|---|---|---|
| **Social Media Timeline** | Events/holidays provider, network OAuth | Types and per-network limits defined |
| **GMB Reviews** | Google Business Profile OAuth | Blocklist and reply contract defined |
| **Keyword volume/difficulty** | SE Ranking, DataForSEO or Ahrefs | `StubKeywordProvider` returns `null`, never invented numbers |
| **Email delivery** | Resend, SES or Postmark | Reset links are logged in development instead |

The keyword provider is the highest-value gap: without it, the content plan ranks
on business relevance alone, and every topic shows "no data" for search volume.

---

## 11. Free-tier limits

Everything below runs on free tiers today.

| | Free limit | First thing to bite |
|---|---|---|
| Supabase | 500 MB, pauses after 7 days idle | Idle pause |
| `gemini-2.5-flash` | 250 req/day | Drafting |
| `gemini-2.5-flash-lite` | 1,000 req/day | Comfortable |
| **`gemini-embedding-001`** | **100 req/day** | **~20 crawls/day** |
| Redis | local, unlimited | — |

**The embedding quota is the real ceiling.** One 40-page crawl produces ~300
chunks batched 64 at a time ≈ 5 requests.

Without an embedding key, retrieval falls back to `hashing-1536` — deterministic,
not semantic. Retrieval still runs but matches poorly, which is worth knowing so
bad output is not mistaken for a prompt problem.

---

## 12. Environment

Required — the app refuses to boot without these:

```
DATABASE_URL                Supabase session pooler (port 5432, not 6543)
REDIS_URL                   redis://localhost:6379
CREDENTIAL_ENCRYPTION_KEY   openssl rand -base64 32
AUTH_SECRET                 openssl rand -base64 32
```

Required for anything to generate:

```
GOOGLE_API_KEY              Gemini
```

Optional:

```
CRAWLER_SERVICE_URL         http://127.0.0.1:8787   — JS-rendered sites
GOOGLE_CLIENT_ID / SECRET                           — "Continue with Google"
ANTHROPIC_API_KEY                                   — better drafting
```

**Use the Supabase session pooler, not the transaction pooler.** The worker runs
multi-statement transactions and writes pgvector batches; a transaction pooler
hands each transaction a different backend, and that breaks only under load.

---

## 13. Operating notes

Things that cost real time during development and are worth knowing:

**Nothing runs without the worker.** Most "it's stuck" symptoms are a worker that
is not running. The dashboard banner says so explicitly.

**Latency is regional.** The database is in Tokyo: ~119 ms per query, ~262 ms per
statement inside a transaction because the pooler pins a backend. An eight-
statement transaction takes ~2.2 s and that is inherent, not a bug.

**`tsx watch` and synced folders do not mix.** The worker's `dev` script runs
plainly for this reason; `dev:watch` exists but a file watcher over OneDrive sees
sync churn as edits and exits.

**A `.next` directory inside OneDrive corrupts.** Symptom is `EINVAL: readlink`.
Fix is `rm -rf apps/web/.next`. The real fix is moving the repo off OneDrive.

**A bare `AggregateError` from a Server Component is a connection failure**, not a
rendering bug — its own `message` is empty and the causes are in `.errors[]`.
