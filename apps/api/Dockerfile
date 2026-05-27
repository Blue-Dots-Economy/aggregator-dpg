# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── installer: resolve and cache workspace deps ───────────────────────────────
# Copy the full repo so every workspace dep's package.json is present for
# pnpm to resolve the api subgraph (api + all its transitive workspace deps).
# Filter scopes the install to that subgraph — unrelated packages skipped.
FROM base AS installer
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@aggregator-dpg/api..."

# ── builder: compile TypeScript ───────────────────────────────────────────────
# pnpm runs `build` topologically across the api subgraph, ensuring every
# workspace dep is compiled before the api itself.
FROM installer AS builder
RUN pnpm --filter "@aggregator-dpg/api..." build

# ── deployer: prune to production deps only ───────────────────────────────────
# Inherit FROM builder so workspace deps' dist/ is present when pnpm deploy
# resolves their files.
FROM builder AS deployer
RUN pnpm deploy --filter @aggregator-dpg/api --prod --legacy /standalone

# ── runner: minimal runtime image ─────────────────────────────────────────────
FROM node:24-alpine AS runner
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=deployer --chown=appuser:appgroup /standalone .
# Schemas are loaded from config/ at runtime by registration-validator.
COPY --from=builder --chown=appuser:appgroup /app/config ./config
# Drizzle migrations are read at runtime by db/migrate.ts (resolved via
# `../../drizzle/migrations` relative to dist/db/, i.e. /app/drizzle/migrations).
COPY --from=builder --chown=appuser:appgroup /app/apps/api/drizzle ./drizzle
# Copy the OTel preload alongside the compiled JS. It's a .mjs source
# file — tsc skips it because it's not .ts — so we copy it from the
# builder context directly.
COPY --from=builder --chown=appuser:appgroup /app/apps/api/src/otel-register.mjs ./dist/otel-register.mjs
USER appuser
EXPOSE 4000
# --import preloads the OTel ESM hook + boots the SDK before server.js
# loads Fastify, so the auto-instrumentation actually patches it.
CMD ["node", "--import", "./dist/otel-register.mjs", "dist/server.js"]
