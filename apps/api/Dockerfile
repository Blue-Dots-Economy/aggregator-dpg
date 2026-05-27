# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── installer: resolve and cache workspace deps ───────────────────────────────
FROM base AS installer
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json                            apps/api/
COPY packages/tsconfig/package.json                   packages/tsconfig/
COPY packages/db-schema/package.json                  packages/db-schema/
COPY packages/queue/package.json                      packages/queue/
COPY packages/schema-loader/package.json              packages/schema-loader/
COPY packages/shared-primitives/package.json          packages/shared-primitives/
COPY packages/telemetry/package.json                  packages/telemetry/
RUN pnpm install --frozen-lockfile

# ── builder: compile TypeScript ───────────────────────────────────────────────
FROM installer AS builder
COPY . .
# Build workspace deps first so the api can import their dist outputs.
RUN pnpm --filter @aggregator-dpg/shared-primitives build \
 && pnpm --filter @aggregator-dpg/db-schema build \
 && pnpm --filter @aggregator-dpg/queue build \
 && pnpm --filter @aggregator-dpg/schema-loader build \
 && pnpm --filter @aggregator-dpg/telemetry build \
 && pnpm --filter @aggregator-dpg/api build

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
