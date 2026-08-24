# syntax=docker/dockerfile:1

# Build stages use the DHI *dev* variant — the only one carrying a shell, apk,
# corepack and npm. The runner below uses the hardened variant, which has none of
# them, so no RUN is possible past that FROM.
FROM dhi.io/node:24-alpine-dev AS base
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
    pnpm install --frozen-lockfile --ignore-scripts --filter "@aggregator-dpg/api..."

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
FROM dhi.io/node:24-alpine AS runner
# Hardened runtime: no shell, no apk, no npm/corepack. The previous
# `RUN addgroup … && adduser …` cannot run here — and is unnecessary: the image
# already ships an unprivileged `node` user at uid 1000, which is exactly the
# runAsUser the deploy charts set for this service, so the two now agree
# (`appuser` was a system-range uid that never matched).
WORKDIR /app
COPY --from=deployer --chown=node:node /standalone .
# Schemas are loaded from config/ at runtime by registration-validator.
COPY --from=builder --chown=node:node /app/config ./config
# Drizzle migrations are read at runtime by db/migrate.ts (resolved via
# `../../drizzle/migrations` relative to dist/db/, i.e. /app/drizzle/migrations).
COPY --from=builder --chown=node:node /app/apps/api/drizzle ./drizzle
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
