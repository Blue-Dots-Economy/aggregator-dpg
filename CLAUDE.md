# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

Aggregator DPG — the Aggregator-facing app of the Blue Dots / Signal Stack ecosystem. pnpm + Turbo monorepo, TypeScript-only. See `README.md` for the product spec and `SETUP.md` for the local-stack walkthrough.

## Toolchain

- **Node** ≥ 24 (CI pins Node 24; Node 22 works locally).
- **pnpm** ≥ 10 — `corepack enable pnpm` or `npm i -g pnpm`. Required (other PMs are not supported).
- **Turbo** orchestrates `build`, `test`, `lint`, `typecheck`, `dev` topologically.
- **Docker + Compose** brings up Postgres (`:5433`), Keycloak (`:8080`), Redis (`:6379`), Mailpit (`:8025`).
- **AWS S3** is **not** in compose — the API and worker hit real S3 via IAM role / `~/.aws/credentials`.

## Common commands

```bash
# Whole-repo
pnpm -w build            # turbo run build (cached, topological)
pnpm -w test             # all package tests (vitest)
pnpm -w lint             # eslint everywhere
pnpm -w typecheck        # tsc --noEmit everywhere
pnpm dep-check           # dep-cruiser: enforces interface-boundary rules (see below)

# Per package / app
pnpm --filter @aggregator-dpg/api dev          # Fastify API on :4000 (tsx watch)
pnpm --filter @aggregator-dpg/web dev          # Next.js portal + BFF on :3000
pnpm --filter @aggregator-dpg/worker dev       # BullMQ worker (tsx watch)
pnpm --filter <pkg> test                       # one package's vitest
pnpm --filter <pkg> test --coverage            # with coverage (≥ 70% line target)
pnpm --filter <pkg> test -- path/to/file.test.ts   # single test file
pnpm --filter <pkg> test -- -t "test name"         # single test by name

# DB (Drizzle, owned by apps/api)
pnpm --filter @aggregator-dpg/api db:generate  # generate new migration after editing schema
pnpm --filter @aggregator-dpg/api db:migrate   # apply migrations
pnpm --filter @aggregator-dpg/api db:studio    # Drizzle Studio

# Local stack
# Cross-platform entrypoint (Windows-friendly; make not required):
pnpm stack:setup        # = make setup  (env + hosts via scripts/stack.mjs)
pnpm stack:up           # = make up
# stack:down | stack:reset | stack:logs | stack:ps | stack:psql | stack:rebuild-web
make setup    # one-shot: copies infra/env.template -> .env (chmod 600) + adds 127.0.0.1 keycloak to /etc/hosts
make up       # docker compose up -d --build (everything containerised)
make down     # stop containers (volumes preserved)
make reset    # docker compose down -v — DESTROYS data volumes
make psql     # psql into local postgres
make rebuild-web         # rebuild web image + restart container (use after NEXT_PUBLIC_* env change)
make rebuild-keycloak    # rebuild OTP SPI jar + restart Keycloak
```

Commits run husky/lint-staged (`prettier --write` + `eslint --fix`) on staged files. Conventional Commits required; **do not bypass with `--no-verify`** (per `CONTRIBUTING.md`).

## Architecture

### Three deployable apps (`apps/`)

- **`api`** — Fastify BFF on `:4000`. Owns the Aggregator DB (Drizzle + Postgres), Keycloak admin integration, registration/approval flow, bulk-upload entry point, registration links, profile endpoints. Reads upstream Signal Stack (UBI backend) and Jobs Stack; in MVP it has **no write access** to Signal Stack except via the bulk-create paths. Every handler asserts `session.aggregator_id`; `aggregator_id` is **never** trusted from the client.
- **`web`** — Next.js 15 (App Router) portal + its own BFF. Anonymous flows hit the backend with a service-account token (`service-token.ts`); authenticated flows attach the user OIDC token via `callApi` (`upstream-client.ts`). Sessions are signed cookies backed by Redis (`lib/session/`). Forms are RJSF-driven from `config/schemas/aggregator/*.json` so non-engineers can evolve the profile/registration forms without code changes.
- **`worker`** — BullMQ jobs (`bulk-file-process`, `bulk-row-process`, `bulk-finalise`, `cron-watchdog`, `link-metrics-rollup`). Consumes the same DB schema + S3 + signalstack-writer. Crontab-style jobs are watchdogged.

### Shared packages (`packages/`)

All cross-package consumption goes through **subpath exports** declared in each `package.json`. Common pattern: every service package exports `./interface` (abstract class + Zod schemas), one or more concrete impls (`./postgres`, `./http`, `./memory`), and `./testing` (in-memory fake + `buildX()` helpers). Apps and other packages import from `./interface` and `./testing` only.

- **`shared-primitives`** — `Result<T, E>` (`ok` / `err` / `match`), typed error hierarchy (`BaseError` → `UpstreamError`, `ConfigError`, `AuthError`, `ValidationError`, `DomainError`), branded IDs, shared DTOs (`Filter`, `Paginated<T>`, `Timestamps`), Beckn primitives, aggregator-specific DTOs.
- **`db-schema`** — Drizzle table definitions and inferred types. The single source of truth for the schema; apps import tables from here.
- **`participants-writer`**, **`signalstack-writer`** — abstract base + Postgres/HTTP impl + in-memory fake. Writers that the API and worker share.
- **`queue`** — BullMQ wiring (queue names, types, connection helpers).
- **`schema-loader`** / **`config-loader`** / **`schema-service`** — config-as-code loaders. Domain/env-specific values come from `config/*.yaml` and `config/schemas/`, **never** hardcoded.
- **`tsconfig`** — `base.json`, `node.json`, `next.json` extends-targets.
- **`_template`** — copy-paste scaffold for a new service package (interface + memory + testing).

### Identity / OIDC

Keycloak realm `aggregator` (imported on first boot from `infra/keycloak/realms/aggregator-realm.json`). Two clients: `aggregator-portal` (web, public, OIDC code flow) and `aggregator-api` (API + BFF service account, confidential). A custom OTP-by-email/phone authenticator SPI is bundled at `infra/keycloak/providers/keycloak-otp-1.0.0-SNAPSHOT.jar` and rebuilt from <https://github.com/sanketika-labs/keycloak-otp-authenticator>. Two protocol mappers (`aggregator_id`, `phone_number` user attributes → token claims) **must be added by hand** after a fresh import — see `SETUP.md` §5; without them the profile endpoint returns `403 MISSING_AGGREGATOR_ID`.

### Local stack run modes

- **Hybrid (dev)** — `docker compose up -d` for backing services + `pnpm --filter ... dev` for api/web/worker outside the container. Uses `apps/<app>/.env` (copy from `.env.example`).
- **Docker-only (VM / prod-like)** — `make setup && make up`. All env values live in a **single root `.env`** sectioned per service (`infra/env.template` is the canonical layout). `NEXT_PUBLIC_API_URL` is baked at compile time, so VM redeploys must use `docker compose up -d --build`.

When deploying to a VM, replace `localhost` and `keycloak` everywhere in `.env` with the VM hostname/IP, and update the `aggregator-portal` client's **Valid Redirect URIs** + **Web Origins** in the Keycloak admin console.

## Project rules (in `.claude/rules/`) — always loaded into context

These override default behaviour and are non-negotiable for any code change:

- **`base-class-pattern.md`** — every cross-package contract is an `abstract class` (NOT a TS `interface` — interfaces are erased at runtime and can't be used as DI tokens or `instanceof` targets). Subclasses preserve exact signatures.
- **`interfaces.md`** — schema/DTO naming (`<Entity>Schema`, `<Entity>Filter`, `Create<Entity>Input`, etc.); only `shared-primitives`, `zod`, `node:*` may be imported in `src/interface.ts` (enforced by dep-cruiser `no-heavy-deps-in-interface`). Service methods return `Result<T, BaseError>` — never throw across a service boundary.
- **`error-handling.md`** — every external call has an explicit timeout, at least one retry with exponential backoff, and a typed error. No empty `catch` blocks.
- **`logging-observability.md`** — use the `logger` from `@aggregator-dpg/observability` (pino-backed). Every entry carries `operation`, `status` (`success`/`failure`/`skipped`), `latency_ms` for external calls, and `error`/`error_type` on failure. No bare `console.log` in module code. Log level from `LOG_LEVEL` env.
- **`testing.md`** + **`testing-requirements.md`** — Vitest only. Cross-package tests import the **fake from `./testing`**, never `vi.mock()` the interface and never `InMemoryService` directly. Every fake extends the in-memory impl (not the abstract base directly) and provides `seed()` + `build<Entity>()` helpers. Tests live in `src/__tests__/`. No real network or DB in unit tests — integration tests get `.integration.test.ts` and are excluded from `pnpm -w test`. Target ≥ 70% line coverage.
- **`configuration-discipline.md`** — no domain/env-specific value is hardcoded. Read once at startup from `@aggregator-dpg/config-loader` or env. Per-env overrides in `config/env/{dev,staging,prod}.yaml`.
- **`code-documentation.md`** — TSDoc on every public class/method/function. First line is a single-sentence summary; document `@param`, `@returns`, `@throws`. Describe _what_ and _why_, not _how_.

The dep-cruiser config (`.dependency-cruiser.cjs`) enforces these at CI time:

1. `no-cross-service-impl-imports` — cross-package imports must go through `./interface` or `./testing` subpaths.
2. `no-heavy-deps-in-interface` — interface files may only import `shared-primitives`, `zod`, or `node:*`.

Run `pnpm dep-check` locally before pushing; it's a required CI step.

## CI

GitHub Actions `CI` job runs on every PR to `main` / `v0.*`: `pnpm -w lint`, `typecheck`, `test`, `build`, then `pnpm dep-check`. A separate `docker / {api,web,worker}` matrix builds and (on non-PR pushes) publishes to GHCR. Branch protection requires the `CI` check (see `docs/ci-required-checks.md`). Tags `web-v*`, `api-v*`, `worker-v*` cut release images per app.
