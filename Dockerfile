# Multi-stage build producing two runnable images from one tree:
#   docker build --target web    -t ourbrand-web .
#   docker build --target worker -t ourbrand-worker .

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /app

# ── Dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json      packages/core/
COPY packages/db/package.json        packages/db/
COPY packages/ai/package.json        packages/ai/
COPY packages/seo/package.json       packages/seo/
COPY packages/voice/package.json     packages/voice/
COPY packages/kb/package.json        packages/kb/
COPY packages/jobs/package.json      packages/jobs/
COPY packages/pipeline/package.json  packages/pipeline/
COPY apps/web/package.json           apps/web/
COPY apps/worker/package.json        apps/worker/
RUN pnpm install --frozen-lockfile

# ── Build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm exec tsc -b
# A production build must not need runtime secrets; these are placeholders that
# satisfy the schema at build time only and are never read by a built artefact.
RUN DATABASE_URL=postgresql://build/build \
    REDIS_URL=redis://build \
    CREDENTIAL_ENCRYPTION_KEY=aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTI= \
    AUTH_SECRET=build-time-placeholder-not-a-real-secret \
    pnpm --filter=@ob/web build

# ── Web ─────────────────────────────────────────────────────────────────────
FROM base AS web
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter=@ob/web", "start"]

# ── Worker ──────────────────────────────────────────────────────────────────
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
CMD ["node", "apps/worker/dist/index.js"]
