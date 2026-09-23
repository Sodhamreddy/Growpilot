# Our Brand — AI SEO & Content Automation Platform

Implementation of `Our_Brand_AI_SEO_Content_Automation_With_Brand_Voice_Explanation.docx`.

This build covers the spec's **Phase 1–3** (§17): auth and multi-tenancy, onboarding,
automatic business detection, the knowledge base, the brand voice engine, the AI
gateway, job orchestration, and the article pipeline through to approval.

**It is not the whole spec.** See [What is not built](#what-is-not-built) — that
section is the honest part of this README and worth reading before the rest.

---

## Quick start

```bash
pnpm install
cp .env.example .env          # fill in the two secrets below
docker compose up -d          # Postgres 16 + pgvector, Redis 7
pnpm db:generate              # generate the Drizzle migration from the schema
pnpm db:migrate               # extensions → schema → indexes
pnpm db:seed                  # demo workspace, confirmed profile, active voice
pnpm dev                      # http://localhost:3002
pnpm dev:worker               # in a second terminal — nothing runs without this
```

The web app listens on **3002**, not 3000 — 3000 and 3001 are commonly taken by
other Next projects. Override with `pnpm --filter=@ob/web dev -- -p 4000`.

There is **one `.env`, at the repo root**. Next normally only reads `.env` from
its own directory, so [apps/web/next.config.mjs](apps/web/next.config.mjs) loads
the root file explicitly; the worker, `db:migrate` and `db:seed` do the same. A
real environment variable always overrides the file, so containers and CI are
unaffected.

### Database — Supabase

Postgres with pgvector, no local install.

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → Database → Connection string → Session pooler**, and put
   it in `DATABASE_URL` in the root `.env`.
3. In the SQL editor, once: `CREATE EXTENSION IF NOT EXISTS vector;`
4. Then:

```bash
pnpm db:migrate
pnpm db:seed
pnpm dev           # web on :3002 AND the worker, in one terminal
```

`pnpm dev` starts both processes. The worker used to be a separate command you
had to remember, and forgetting it is indistinguishable from the app being
broken: pages load, buttons work, and nothing ever finishes because no process
is consuming the queue.

`pnpm dev:web` and `pnpm dev:worker` still run them separately when you want
one without the other.

`pnpm --filter=@ob/web build` writes to `.next-build`, not `.next`. Running a
production build into the directory a dev server is using replaces its manifests
with production ones, and the dev server then dies on a `routes-manifest.json`
that no longer describes it — recoverable only by deleting `.next` and starting
over.

`dev:worker` runs the worker directly. `pnpm --filter=@ob/worker dev:watch` adds
file watching and restarts on save — useful when editing processors, but avoid
it if the repo lives in a synced folder (OneDrive, Dropbox): the watcher sees
the sync churn as edits and restarts in a loop or exits.
```

**Use the session pooler (port 5432), not the transaction pooler (6543).** The
worker runs multi-statement transactions and the knowledge-base index writes
pgvector batches; a transaction pooler hands each transaction a different
backend, and that breaks in ways which only appear under load. `prepare: false`
is set regardless, because prepared statements are the other thing poolers
break.

Supabase caps total connections per project — 60 on the free tier, shared
across web, worker, and anything else holding a connection. `DATABASE_POOL_MAX`
is per process, so keep the sum under that ceiling.

TLS is on automatically for any non-localhost host. `DATABASE_SSL=disable` for a
plain local server, `=verify` to demand a chain that validates.

### Other options

`docker compose up -d` is the easy path, but only Postgres genuinely needs it —
and it must have the **pgvector** extension, which the retrieval layer depends on.
If Docker is not available:

- **Hosted Postgres** is the least painful option. Neon and Supabase both ship
  pgvector; create a database and point `DATABASE_URL` at it.
- **Redis** can be any Redis-compatible server. Memurai works on Windows.

Check what the app can actually reach at any time:

```bash
curl http://localhost:3002/api/health
```

It reports each dependency separately and returns 503 until both are up.

Two secrets have no safe default and must be generated:

```bash
openssl rand -base64 32   # → CREDENTIAL_ENCRYPTION_KEY
openssl rand -base64 32   # → AUTH_SECRET
```

Set `ANTHROPIC_API_KEY` for real generation, or `AI_MOCK=1` to run the entire
pipeline offline against a deterministic local provider.

The seed prints demo credentials. **Change the password before exposing the app.**

---

## Architecture

```
apps/web        Next.js 15 App Router — UI + 19 API routes
apps/worker     BullMQ workers — 7 queues
packages/core   Config, typed errors, tenancy, crypto, redacting logger
packages/db     Drizzle schema (16 entities), tenant-scoped repositories
packages/ai     AI Gateway: task-alias routing, fallback, cost accounting
packages/seo    Crawler, HTML parser, explainable scorer, deterministic checks
packages/voice  Brand voice profile, prompt rendering, voice QA
packages/kb     Chunking and pgvector retrieval
packages/jobs   Queue definitions, idempotency, dead-letter, replay
packages/pipeline  Extraction, brief, article, quality gates, approval FSM
```

Postgres 16 + pgvector · Redis 7 · TypeScript strict · 113 unit tests.

### Design decisions worth knowing

**Tenancy is a parameter, not a convention.** Every repository function takes a
`TenantContext` as its first argument and derives its `WHERE` clause from it.
There is no code path that reads workspace data without one
([packages/db/src/repo.ts](packages/db/src/repo.ts)).

**The AI gateway is the only thing that knows model names.** Features request a
task alias (`writing_long`, `structured_json`); the registry maps aliases to a
provider/model fallback chain. Changing models is an edit to one table
([packages/ai/src/registry.ts](packages/ai/src/registry.ts)). The gateway
enforces the per-workspace budget *before* spending and records model, prompt
version, tokens, latency and cost for every attempt, successful or not.

**Prompt layers are structurally separated** (spec §18.4). `composeSystemPrompt`
is the only way to build a system prompt and enforces the order
`SYSTEM RULES → SAFETY → BUSINESS FACTS → SOURCE EVIDENCE → BRAND VOICE → TASK →
OUTPUT FORMAT`. It returns the offset where the stable prefix ends, which the
Anthropic adapter uses as a cache breakpoint — generating a batch of articles for
one business reuses the cached prefix.

**Publication is gated by a state machine, not by discipline.** `draft →
published` is not a legal transition. `canPublish` re-reads live state at publish
time rather than trusting that the gates passed earlier
([packages/pipeline/src/approval.ts](packages/pipeline/src/approval.ts)).

**The crawler cannot be used as a proxy.** It accepts a customer-supplied URL, so
it resolves DNS up front, rejects private/loopback/link-local/metadata addresses,
and re-validates every redirect hop
([packages/seo/src/crawler/fetch.ts](packages/seo/src/crawler/fetch.ts)). The spec
does not mention this; no crawler taking arbitrary input is production-ready
without it.

**Missing data is shown as missing.** No keyword provider is configured, so
volume and difficulty are `null` and the UI renders "no data". A fabricated
search volume would flow into the opportunity score and into a content plan a
customer acts on.

---

## Spec coverage

| § | Area | Status |
|---|---|---|
| 2 | Onboarding, signup, progressive questions | Built |
| 3 | Crawl, extraction, evidence + confidence | Built |
| 4 | Knowledge base, chunking, pgvector retrieval | Built |
| 5 | Multi-LLM gateway, aliases, fallback, budgets | Built |
| 6.1 | Keyword seeds, intent, clustering, prioritisation | Built (no volume provider) |
| 6.2–6.3 | Brief → draft → QA → approval | Built |
| 7.1 | Explainable weighted score | Built — exact weights, 16 tests |
| 10 | Home, sidebar, UX principles | Built (5 of 12 modules) |
| 11 | Publishing architecture, idempotency, credential encryption | Data model + route only |
| 12 | 7 queues, retry, DLQ, replay, correlation IDs | Built |
| 13 | Data model — 16 entities | Built |
| 14 | API structure | All 18 routes + health |
| 15 | Tenancy, encryption, audit, rate limits, 7 quality gates | Built |
| 16 | Analytics | Schema + endpoint; no ingestion |
| 18 | Brand voice engine | Built — extraction, rules, QA, channels |

### What is not built

Deferred from Phase 4–8, and honestly labelled in the UI (greyed sidebar items):

- **CMS publishing execution.** `/api/articles/:id/publish` validates everything,
  writes a `publish_jobs` row and guarantees idempotency — but no worker performs
  the WordPress/Webflow/Ghost call. The seam is clean; the connector is missing.
- **OAuth integrations.** The `integrations` table, credential sealing
  (AES-256-GCM) and status handling exist. No provider flow is wired.
- **Analytics ingestion.** Search Console / GA4 / rank tracking. The endpoint
  returns an empty `sources` list and says so rather than showing zeros.
- **Local SEO, Social Media, Content Hub calendar, SEO Audit module,
  Preferences UI.**
- **Google OAuth signup.** Email/password is complete; `GOOGLE_CLIENT_ID` is
  read but unused.
- **JS rendering.** The crawler is a static fetcher. It detects client-rendered
  sites and reports `jsHeavy` with a warning instead of silently extracting
  nothing (spec §18.1 critical test).

---

## Two corrections to the spec

**1. The model table in §5.1 names models I cannot verify.** `GPT-5.6 Sol`,
`GPT-5.6 Terra`, `GPT-5.6 Luna` and `Gemini 3.1 Pro` are not identifiers I can
confirm exist. Rather than hardcode them, [registry.ts](packages/ai/src/registry.ts)
pins verified Anthropic models and declares the OpenAI/Google rungs from
environment variables, so they activate the moment you supply a real model name
plus a key. Current Anthropic models and list pricing:

| Role in §5.1 | Model | Input / Output per 1M |
|---|---|---|
| Complex reasoning, research | `claude-opus-5` | $5 / $25 |
| Long-form writing, editing | `claude-sonnet-5` | $2 / $10 |
| Bulk classification | `claude-haiku-4-5` | $1 / $5 |

Spec §5.1 also lists `Claude Sonnet 4.6`, which is real but previous-generation;
`claude-sonnet-5` supersedes it at lower cost.

**2. §18 is used twice** — "QA & Acceptance Criteria" and "Brand Voice & Content
Voice Engine" share the number. Both are implemented; this README cites the brand
voice one as §18 throughout.

---

## Testing

```bash
pnpm test          # 113 tests, no network, no credentials
pnpm typecheck     # strict, project references
```

Coverage is deliberately concentrated on what is expensive to get wrong:

| Area | Tests | Why |
|---|---|---|
| SSRF guard | 17 | The crawler takes user-supplied URLs |
| Credential sealing, password hashing | 14 | Tamper detection, timing, unicode |
| Explainable score | 16 | Weights must match §7.1 exactly and stay explainable |
| Voice QA | 23 | Banned terms, unsupported claims, CTA conformance |
| robots.txt | 14 | Longest-match precedence, wildcards, UA specificity |
| Approval state machine | 18 | `draft → published` must be unreachable |
| AI gateway | 11 | Fallback, retry policy, budget, cost accounting |

One test caught a real bug during the build: a stuffed article scored *above* a
clean one because the fixture's body never contained the keyword. The fixture was
wrong; the scorer was right. Both are now realistic.

---

## Deployment

```bash
docker build --target web    -t ourbrand-web .
docker build --target worker -t ourbrand-worker .
```

The web image exposes `/api/health`, which returns 503 when Postgres or Redis is
unreachable so a load balancer stops routing to it.

**Before you put this in front of a customer:**

1. Rotate `CREDENTIAL_ENCRYPTION_KEY` and `AUTH_SECRET`; store them in a secrets
   manager, not in `.env`.
2. Change the seeded demo password, or do not run the seed.
3. Set a real `CRAWL_USER_AGENT` with a contact URL.
4. Review the per-workspace `ai_budget_micros` default (currently $50/month).
5. Put TLS in front of the web container — the session cookie sets `secure` only
   when `NODE_ENV=production`.
6. Run `pnpm db:migrate` as a deploy step; the worker and web do not self-migrate.

---

## The original document

[docs/legacy-mockup/](docs/legacy-mockup/) holds the earlier static prototype
(hardcoded data, localStorage) that this replaces. It is kept for reference only
and is not part of the build.
