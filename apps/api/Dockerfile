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
RUN pnpm install --frozen-lockfile

# ── builder: compile TypeScript ───────────────────────────────────────────────
FROM installer AS builder
COPY . .
RUN pnpm --filter @aggregator-dpg/api build

# ── deployer: prune to production deps only ───────────────────────────────────
FROM installer AS deployer
COPY --from=builder /app/apps/api/dist ./apps/api/dist
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
