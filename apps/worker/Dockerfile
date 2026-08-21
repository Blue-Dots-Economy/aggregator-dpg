# syntax=docker/dockerfile:1
#
# Bulk-upload worker (BullMQ consumer) — same monorepo as the API, different
# entrypoint. Builds the worker package + its workspace deps, then prunes to a
# production image.

# Build stages use the DHI *dev* variant — the only one carrying a shell, apk,
# corepack and npm. The runner below uses the hardened variant, which has none of
# them, so no RUN is possible past that FROM.
FROM dhi.io/node:24-alpine-dev AS base
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
    pnpm install --frozen-lockfile --ignore-scripts --filter "@aggregator-dpg/worker..."

# ── builder: compile workspace + worker ──────────────────────────────────────
# pnpm runs `build` topologically across the worker subgraph.
FROM installer AS builder
RUN pnpm --filter "@aggregator-dpg/worker..." build

# ── deployer: prune to prod deps (workspace dist/ already present) ───────────
FROM builder AS deployer
RUN pnpm deploy --filter @aggregator-dpg/worker --prod --legacy /standalone

# ── runner: minimal runtime ──────────────────────────────────────────────────
FROM dhi.io/node:24-alpine AS runner
# Hardened runtime: no shell, no apk, no npm/corepack. The previous
# `RUN addgroup … && adduser …` cannot run here — and is unnecessary: the image
# already ships an unprivileged `node` user at uid 1000, matching the runAsUser
# the deploy charts set for this service.
#
# DEPLOY NOTE: the worker's liveness probe in the charts is
# `exec: [sh, -c, 'pgrep -f "node" …']`. This image has neither `sh` nor
# `pgrep`, so that probe must be removed (or replaced with a real health
# endpoint) or the pod will fail liveness and restart in a loop.
WORKDIR /app
COPY --from=deployer --chown=node:node /standalone .
# Worker reads JSON Schemas from /app/config at runtime (participant validator).
COPY --from=builder --chown=node:node /app/config ./config
USER node
CMD ["node", "dist/main.js"]
