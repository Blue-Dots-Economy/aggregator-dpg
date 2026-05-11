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
FROM base AS installer
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json                          apps/worker/
COPY packages/tsconfig/package.json                    packages/tsconfig/
COPY packages/db-schema/package.json                   packages/db-schema/
COPY packages/queue/package.json                       packages/queue/
COPY packages/schema-loader/package.json               packages/schema-loader/
COPY packages/shared-primitives/package.json           packages/shared-primitives/
RUN pnpm install --frozen-lockfile

# ── builder: compile workspace + worker ──────────────────────────────────────
FROM installer AS builder
COPY . .
RUN pnpm --filter @aggregator-dpg/shared-primitives build \
 && pnpm --filter @aggregator-dpg/db-schema build \
 && pnpm --filter @aggregator-dpg/queue build \
 && pnpm --filter @aggregator-dpg/schema-loader build \
 && pnpm --filter @aggregator-dpg/worker build

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
USER appuser
CMD ["node", "dist/main.js"]
