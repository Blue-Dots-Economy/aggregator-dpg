# syntax=docker/dockerfile:1
# Stub — update COPY and CMD when Next.js is scaffolded (F-17.x):
#   - COPY .next/standalone and .next/static from builder
#   - CMD ["node", "server.js"]

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── installer: resolve and cache workspace deps ───────────────────────────────
FROM base AS installer
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json                            apps/web/
COPY packages/tsconfig/package.json                   packages/tsconfig/
RUN pnpm install --frozen-lockfile

# ── builder: compile / next build ─────────────────────────────────────────────
FROM installer AS builder
COPY . .
RUN pnpm --filter @aggregator-dpg/web build

# ── deployer: prune to production deps only ───────────────────────────────────
FROM installer AS deployer
COPY --from=builder /app/apps/web/dist ./apps/web/dist
RUN pnpm deploy --filter @aggregator-dpg/web --prod /standalone

# ── runner: minimal runtime image ─────────────────────────────────────────────
FROM node:24-alpine AS runner
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=deployer --chown=appuser:appgroup /standalone .
USER appuser
EXPOSE 3001
# TODO(F-17.x): switch to `node server.js` once Next.js standalone output is wired
CMD ["node", "dist/index.js"]
