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
USER appuser
EXPOSE 4000
CMD ["node", "dist/server.js"]
