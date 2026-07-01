# syntax=docker/dockerfile:1.7
#
# Blue Dots Aggregator Portal — Next.js 15 production image (apps/web).
#
# Multi-stage build aligned with repo template. Uses Next.js standalone output
# (`output: 'standalone'` in next.config.ts) so the runtime image only carries
# the compiled server, .next/static, and public/ assets — no pnpm, no source.
#
#   1. base       — node:24-alpine + corepack
#   2. installer  — workspace deps (filtered to web)
#   3. builder    — `next build` produces .next/standalone
#   4. runner     — minimal runtime, runs as non-root nextjs user on :3000

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="$PNPM_HOME:$PATH" \
    CI=true
RUN corepack enable

# ── installer ─────────────────────────────────────────────────────────────────
FROM base AS installer
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json                    apps/web/package.json
COPY packages/tsconfig/package.json           packages/tsconfig/package.json
# web's server components read consent config via @aggregator-dpg/config-loader,
# which pulls in @aggregator-dpg/shared-primitives. Their package.json files must
# be present so pnpm installs their deps (e.g. zod) into the web subgraph.
COPY packages/config-loader/package.json      packages/config-loader/package.json
COPY packages/shared-primitives/package.json  packages/shared-primitives/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @aggregator-dpg/web...

# ── builder ───────────────────────────────────────────────────────────────────
FROM installer AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* vars are inlined into the client bundle at build time by Next.js.
# Declare them as ARGs so they can be forwarded from `docker build --build-arg`
# or from docker-compose `build.args`, then promote to ENV so `next build` sees them.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_ENABLED_LANGUAGES=en,kn,hi
ENV NEXT_PUBLIC_ENABLED_LANGUAGES=$NEXT_PUBLIC_ENABLED_LANGUAGES
COPY . .
RUN pnpm --filter @aggregator-dpg/web build

# ── runner ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG VERSION=0.0.0

LABEL org.opencontainers.image.title="aggregator-dpg-web" \
      org.opencontainers.image.description="Blue Dots Aggregator Portal (Next.js)" \
      org.opencontainers.image.source="https://github.com/sanketika-labs/aggregator-dpg" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app

# Next.js standalone output already prunes node_modules to the bare minimum.
# Copy in standalone server, static assets, and public/ — chown to non-root.
COPY --from=builder --chown=appuser:appgroup /app/apps/web/.next/standalone ./
COPY --from=builder --chown=appuser:appgroup /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=builder --chown=appuser:appgroup /app/apps/web/public           ./apps/web/public
# Participant JSON Schemas are loaded at runtime by the public /r/[slug]
# page. Next's output-file tracer doesn't pick them up because they're
# read via dynamic `path.resolve(...)`, so copy them explicitly. Copying
# the whole `config/` tree pulls in both the shared aggregator schemas
# (`config/schemas/aggregator/`) and every per-network folder (e.g.
# `config/blue_dot/schemas/participant/`); the active network is picked
# via `SCHEMA_ROOT_DIR` at runtime.
COPY --from=builder --chown=appuser:appgroup /app/config                    ./config

USER appuser
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
