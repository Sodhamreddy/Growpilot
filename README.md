# GrowPilot

GrowPilot is a multi-client content workspace for blog automation, social planning and publishing, business intelligence, and Google Business Profile reviews.

The existing monorepo remains organized as a Next.js web app, a BullMQ worker, shared TypeScript packages, and an optional Python rendering service.

## Local setup

Requirements: Node.js 22+, pnpm 10.33, Postgres with pgvector, and Redis. The optional rendering service requires Python and Chromium; see [its setup guide](services/crawler/README.md).

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Fill in DATABASE_URL, REDIS_URL, CREDENTIAL_ENCRYPTION_KEY, and AUTH_SECRET.
# For disposable local infrastructure:
docker compose up -d
pnpm typecheck
pnpm db:migrate
pnpm db:seed       # Optional demo data; development only.
pnpm dev
```

On PowerShell, use `Copy-Item .env.example .env`. Generate each secret independently with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

The app runs at **http://localhost:3002**. `pnpm dev` starts web, worker, and the crawler launcher together; do not start a second worker unintentionally. Use `pnpm dev:web`, `pnpm dev:worker`, or `pnpm dev:crawler` to run them separately. Configure the optional crawler before using its launcher.

Use the committed migrations for setup. `pnpm db:generate` is for deliberate schema development, not a prerequisite for installing the application. Manual `post_` migrations follow generated migrations; future generated migrations must account for these existing changes.

Environment variables are loaded from the root `.env`, with process environment variables taking precedence. `AI_MOCK=1` uses deterministic local generation for development. It does not turn live CMS or social publishing into a mock; leave those accounts disconnected in test environments.

## Project layout

| Location | Responsibility |
| --- | --- |
| `apps/web` | Next.js App Router UI, authentication, API endpoints |
| `apps/worker` | Background processing, schedules, retries, durable publication dispatch |
| `packages/core` | Configuration, errors, tenancy, encryption, logging, cancellation |
| `packages/db` | Schema, migrations, repositories, atomic AI budget reservations |
| `packages/ai` | Provider routing, generation, embeddings, cost accounting |
| `packages/seo`, `voice`, `kb`, `pipeline` | Crawling, analysis, brand voice, retrieval, quality gates |
| `packages/blog`, `publish` | Keyword research, content planning, measurement, WordPress |
| `packages/social`, `gmb`, `companion`, `jobs` | Social workflows, reviews, assistant, queues |
| `services/crawler` | Optional Chromium rendering and Maps support |

## Client selection and publishing

Client selection is stored per workspace member. WordPress connections belong to a specific client, and a queued article records its destination, site fingerprint, and article version. Changes to that destination or version require a new reviewed attempt.

WordPress exports are **drafts**. Publishing the draft on WordPress remains a human action. The Integrations page can reconcile a WordPress post ID and update the article when the post is actually live.

Social publishing requires approved copy and an approved image. Each successful network result is saved before the next network is called. A timeout or crash after a publishing request can leave the result uncertain; the application holds it for review rather than sending another post automatically.

- WordPress recovery: **Integrations → Publish activity**. Reconcile the existing post ID, or confirm no post exists before retrying.
- Social recovery: **Social → Schedule → Recover interrupted publishing**. An administrator checks each network and records the existing post or confirms it is absent. Failed networks can then be scheduled again.
- Queued WordPress and social publications are periodically dispatched from database records, so a lost enqueue does not silently lose the work.

## Optional connections

| Feature | Configuration |
| --- | --- |
| Production password reset | `RESEND_API_KEY`, verified `EMAIL_FROM`, correct public `APP_URL` |
| AI providers | Keys and model routing in `.env.example` and `packages/ai/src/registry.ts` |
| Keyword volume and difficulty | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, numeric `DATAFORSEO_LOCATION_CODE` |
| Search Console / GA4 | Per-client service-account connection on **Integrations** |
| WordPress | Per-client site URL, username, application password in Settings |
| Facebook / Instagram | Meta application permissions and the client's selected Page |
| Instagram image hosting | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optional storage bucket |
| Google Business Profile | Google GBP OAuth credentials; Maps key where required |

Keyword data remains null when no metrics provider is configured. DataForSEO uses its own provider credit, separate from the AI budget. The location code supplies the default market. A research location overrides it using the provider's exact location name.

For Google measurement, enable the Search Console API or Analytics Data API in the service account's project. Grant that service account read access to the exact Search Console property or GA4 property, then paste the service-account JSON into the corresponding client connection form. Use a Search Console property such as `sc-domain:example.com` or its exact URL-prefix property, and a numeric GA4 property ID. Credentials are sealed before storage and are not returned by the API.

Measurement sync refreshes 28 days ending three days ago and preserves older daily history. GSC query rows are separate from site totals to avoid double counting. Available query demand can add at most ten priority points during future content planning; it does not fabricate search volume or automatically rewrite approved content. Query data can be incomplete because of provider privacy filtering and a 100,000-row sync cap. Analytics and email require real account permissions to validate end to end.

API references: [Search Console](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), [GA4 reporting](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport), [Google service accounts](https://developers.google.com/identity/protocols/oauth2/service-account), [DataForSEO keyword overview](https://docs.dataforseo.com/v3/dataforseo_labs-google-keyword_overview-live/), [Resend email](https://resend.com/docs/api-reference/emails/send-email).

## Reliability and security

Remote database connections verify certificates and hostnames by default. Supabase database hosts automatically use the bundled [Supabase root CA](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt), so the session and transaction poolers work without disabling verification. For other private CAs, export `NODE_EXTRA_CA_CERTS` before starting Node; setting it in `.env` is too late for Node's startup trust configuration. `DATABASE_SSL=require` is an explicit compatibility override that disables certificate verification. Localhost defaults to an unencrypted local connection. Size `DATABASE_POOL_MAX` for the total number of web and worker processes.

AI calls reserve estimated cost under a workspace database lock before starting. Completed usage replaces that reservation atomically. Embeddings participate in the same budget. Update model prices when changing models, including `EMBEDDING_COST_PER_MTOK` ([Google pricing](https://ai.google.dev/gemini-api/docs/pricing)). Usage accounting is an estimate and does not replace the provider invoice. Failed calls with uncertain billing or interrupted accounting retain their reservation conservatively. An operator should compare those holds with provider usage before releasing them; current-month holds count toward the budget. A budget of zero means unlimited.

Public URL connections validate every resolved address and pin the actual socket to a checked address. Redirects are checked independently. Browser requests use a guarded resolver; private subresources and WebSockets are blocked, with a deny proxy for browser traffic that bypasses interception. Keep the rendering service on a private interface and apply deployment egress restrictions as an additional boundary.

Password-reset tokens are consumed atomically and existing sessions are removed on success. Production resets use email; local development displays a test link. Rate limits are scoped by route, method, and tenant or IP, and return a temporary failure if Redis is unavailable. Reverse proxies must overwrite untrusted forwarding headers.

## Verification

```sh
pnpm typecheck
pnpm --filter=@ob/web exec tsc --noEmit
pnpm lint
pnpm test --maxWorkers=2 --minWorkers=1
pnpm --filter=@ob/web build
# From the crawler virtual environment:
python -m unittest discover -s services/crawler -p 'test_network.py'
```

The suite includes database migration and client-isolation integration tests using PGlite, publishing failure tests, budget tests, provider response tests, and URL protection tests. CI additionally migrates and seeds disposable Postgres, builds the web app, runs authenticated HTTP smoke checks, and builds both deployment images. `scripts/smoke.mjs` is CI-only and must use disposable data. Browser interaction and real external accounts still need deployment-specific acceptance testing.

Production builds use `.next-build`, separate from the development server's `.next`. In a synced directory such as OneDrive, use the non-watching worker command if filesystem churn causes restarts.

## Deployment and upgrading

```sh
docker build --target web -t growpilot-web .
docker build --target worker -t growpilot-worker .
```

The web image listens on **3002**. Both images need runtime environment variables, reachable Postgres and Redis, and the same credential encryption key. Run web and worker together. Provide shared persistent image storage (or configured Supabase Storage) when they run separately. Set `IMAGE_STORE_DIR` to the same mounted directory in both processes if using local storage. Run the optional crawler separately and set `CRAWLER_SERVICE_URL` to its private address.

Before rolling out this upgrade:

1. Back up the database and stop old workers while migrating.
2. Run `pnpm db:migrate` once with the deployment database configuration, then start the new web and worker versions together.
3. Reconnect WordPress explicitly for each client. Legacy shared connections are preserved, but queued jobs with no unambiguous destination are marked failed for review.
4. Check **Integrations → Publish activity** and social schedules for interrupted work before retrying it. Older social schedules without a recorded target account must be reviewed and scheduled again.
5. Confirm `/api/health` returns 200 and the worker heartbeat is healthy. Validate production password recovery and configured providers with designated test accounts.

The social migration preserves existing monthly topics in an “Existing topics” category, retains the legacy brief as the hook, and allows new unscheduled ideas. Do not run `db:reset` or the demo seed against production. The Docker context excludes local environment files, dependency directories, build output, and stored images.

Webflow, Ghost, custom webhook publishing, LinkedIn/X publishing, and rank-tracker ingestion remain unavailable. They are separate features, not enabled by adding credentials to the existing implemented connectors.
