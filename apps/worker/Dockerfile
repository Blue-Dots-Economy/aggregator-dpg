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
# DEPLOY NOTE: the worker's old liveness probe was
# `exec: [sh, -c, 'pgrep -f "node" …']`. This image has neither `sh` nor
# `pgrep`, so bluedots-automation#152 removed the probe from
# helm/aggregator/charts/worker/templates/deployment.yaml rather than replace
# it — `pgrep` only proved PID 1 was alive, which the kubelet already restarts
# on exit, so net posture is unchanged. That leaves a real gap a process-alive
# check never covered anyway: a wedged BullMQ consumer (blocked event loop,
# half-open Redis connection, stalled job) is invisible either way. A real
# health/queue-heartbeat endpoint would need to be a fresh addition, not a
# probe restoration.
WORKDIR /app
COPY --from=deployer --chown=node:node /standalone .
# Worker reads JSON Schemas from /app/config at runtime (participant validator).
COPY --from=builder --chown=node:node /app/config ./config
USER node
CMD ["node", "dist/main.js"]
