# syntax=docker/dockerfile:1
#
# Bulk-upload worker (BullMQ consumer) — same monorepo as the API, different
# entrypoint. Builds the worker package + its workspace deps, then prunes to a
# production image.

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── installer: resolve workspace deps ────────────────────────────────────────
# Copy the full repo so every workspace dep's package.json is present for
# pnpm to resolve the worker subgraph. Filter scopes the install to that
# subgraph — unrelated packages skipped.
FROM base AS installer
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@aggregator-dpg/worker..."

# ── builder: compile workspace + worker ──────────────────────────────────────
# pnpm runs `build` topologically across the worker subgraph.
FROM installer AS builder
RUN pnpm --filter "@aggregator-dpg/worker..." build

# ── deployer: prune to prod deps (workspace dist/ already present) ───────────
FROM builder AS deployer
RUN pnpm deploy --filter @aggregator-dpg/worker --prod --legacy /standalone

# ── runner: minimal runtime ──────────────────────────────────────────────────
FROM node:24-alpine AS runner
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=deployer --chown=appuser:appgroup /standalone .
# Worker reads JSON Schemas from /app/config at runtime (participant validator).
COPY --from=builder --chown=appuser:appgroup /app/config ./config
# Copy the OTel preload alongside the compiled JS.
COPY --from=builder --chown=appuser:appgroup /app/apps/worker/src/otel-register.mjs ./dist/otel-register.mjs
USER appuser
# --import preloads the OTel ESM hook + boots the SDK before main.js
# loads BullMQ, so the auto-instrumentation actually patches it.
CMD ["node", "--import", "./dist/otel-register.mjs", "dist/main.js"]
