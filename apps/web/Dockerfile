# syntax=docker/dockerfile:1.7
#
# Blue Dots Aggregator Portal — production image (apps/web).
#
# Multi-stage build aligned with repo template (services/Dockerfile.template):
#   1. base       — node:24-alpine + corepack
#   2. installer  — workspace deps (filtered to web)
#   3. builder    — Vite production build
#   4. deployer   — pnpm deploy → self-contained /standalone
#   5. runner     — minimal runtime, runs as non-root appuser on :8080
#
# Static assets are served by `serve` (pinned dep). No nginx, no second runtime.

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="$PNPM_HOME:$PATH" \
    CI=true
RUN corepack enable

# ── installer ─────────────────────────────────────────────────────────────────
FROM base AS installer
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json               apps/web/package.json
COPY packages/tsconfig/package.json      packages/tsconfig/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @aggregator-dpg/web...

# ── builder ───────────────────────────────────────────────────────────────────
FROM installer AS builder
COPY . .
RUN pnpm --filter @aggregator-dpg/web build

# ── deployer ──────────────────────────────────────────────────────────────────
FROM installer AS deployer
COPY --from=builder /app/apps/web/dist        /app/apps/web/dist
COPY --from=builder /app/apps/web/serve.json  /app/apps/web/serve.json
RUN pnpm deploy --filter @aggregator-dpg/web --prod --legacy /standalone

# ── runner ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG VERSION=0.0.0

LABEL org.opencontainers.image.title="aggregator-dpg-web" \
      org.opencontainers.image.description="Blue Dots Aggregator Portal SPA" \
      org.opencontainers.image.source="https://github.com/sanketika-labs/aggregator-dpg" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production \
    PORT=8080

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=deployer --chown=appuser:appgroup /standalone ./

USER appuser
EXPOSE 8080

CMD ["node", "node_modules/serve/build/main.js", "-s", "dist", "-l", "8080", "--no-clipboard", "--no-port-switching"]
