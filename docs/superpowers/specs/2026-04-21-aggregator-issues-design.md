# Aggregator DPG — Issue Set Design

**Date:** 2026-04-21
**Author:** Aniket Sakinala (+ Claude)
**Source:** `README.md` (Technical Specification, Draft v0.1) ← PRD `docs/Aggregator Product Note.pdf`
**Status:** Approved for issue drafting

---

## 1. Purpose

Define the full set of GitHub issues (epics, features, tasks) required to deliver the Aggregator DPG MVP, structured so that:

1. Every service has an explicit interface (ABC-equivalent in TS) + an implementation adapter, with consumers unaware of the underlying tech.
2. All domain variability (profile schemas, entities, upstream endpoints, onboarding modes, feature toggles) is driven by configuration files, not code.
3. Work is trackable both by engineering block (backend/frontend/db/auth/observability) and by PRD phase/JTBD, in parallel.

The issues are drafted as markdown files first (`docs/issues/`), reviewed, then pushed to GitHub with labels, milestones, and Projects v2 tracking.

## 2. Confirmed decisions

| # | Decision |
|---|---|
| Q1 | Draft markdown first → review → push via `gh` CLI |
| Q2 | Node.js + TypeScript backend; Next.js + TypeScript frontend. Interface/impl pattern via TS `interface` + abstract class |
| Q3 | Monorepo (pnpm + turbo workspaces) |
| Q4 | MVP fully detailed + single tracking epic for deferred JTBDs (AG-0a, AG-3, AG-4, AG-5, AG-7, AG-8) + 8 Future Scope items as stubs |
| Q5 | Single config source — YAML files under `config/`, validated via Zod |
| Q6 | 13 core service interfaces (see §4) |
| Q7 | 3-level hierarchy: Epic → Feature → Task |
| Q8 | Every task carries acceptance criteria + tests (unit mandatory, integration/e2e per feature) |
| + | GitHub Projects v2 tracking alongside issues, using Approach 3 (hybrid matrix: Platform epics + Product epics + Post-MVP tracking epic) |

## 3. Repository & monorepo layout (hybrid per-service)

Every service package is self-contained — interface, implementations, config schema, and defaults all live together. Subpath exports separate the interface surface from the implementation surface so consumers can depend on types only, and alternate impls (e.g., a fake for tests) slot in without a new package. A small `shared-primitives` package holds the irreducible cross-service types (error base classes, branded IDs, `Result`, common DTOs).

```
aggregator-dpg/
├── apps/
│   ├── web/                        # Next.js (App Router) — Aggregator web app
│   └── api/
│       ├── src/composition.ts      # DI wiring: binds each interface to a concrete impl
│       └── ...
├── services/
│   └── signal-processing/          # Standalone SPS (materialised signals)
├── packages/
│   ├── shared-primitives/          # Errors, branded IDs, Result, base DTOs (only truly shared types)
│   ├── db/
│   │   ├── src/interface.ts        # DBService, Repository<T>, UnitOfWork
│   │   ├── src/postgres/           # Postgres impl + migrations
│   │   ├── src/testing/            # In-memory fake for tests
│   │   ├── src/config.schema.ts    # Zod for this service
│   │   ├── config.defaults.yaml
│   │   └── package.json            # subpath exports: ./interface, ./postgres, ./testing
│   ├── auth/
│   │   ├── src/interface.ts        # AuthService, OtpProvider
│   │   ├── src/otp/                # OTP impl + JWT logic
│   │   ├── src/testing/
│   │   ├── src/config.schema.ts
│   │   ├── config.defaults.yaml
│   │   └── package.json
│   ├── signal-stack/               # SignalStackClient interface + REST adapter + config
│   ├── jobs-stack/                 # JobsStackClient interface + REST adapter + config
│   ├── signal-processing-client/   # SPC interface + HTTP adapter + config
│   ├── storage/                    # StorageService interface + S3 impl + local-dev impl
│   ├── email/                      # EmailService interface + provider impl
│   ├── queue/                      # QueueService interface + BullMQ impl
│   ├── cache/                      # CacheService interface + Redis impl
│   ├── observability/              # Logger/Metrics/Tracer interfaces + pino/Prom/OTel impls
│   ├── config-loader/              # ConfigService: discovers per-package schemas, composes, validates
│   └── schema-service/             # SchemaService interface + impl + config (profile schemas)
├── config/
│   └── env/
│       ├── dev.yaml                # Aggregated env overrides (ops-owned)
│       ├── staging.yaml
│       └── prod.yaml
├── docs/
│   ├── superpowers/specs/
│   └── issues/
└── .github/
    ├── ISSUE_TEMPLATE/{epic.md,feature.md,task.md}
    └── workflows/
```

**Per-package conventions (enforced by lint rules + CI):**

- Each service package exports at minimum:
  - `./interface` — only types, abstract classes, and Zod schemas. Zero runtime deps besides `shared-primitives` and `zod`.
  - `./impl-name` (e.g., `./postgres`, `./redis`) — concrete implementations. May have heavy deps.
  - `./testing` — in-memory/fake impls for tests.
- Service-to-service references use `./interface` only. A service may not import another service's impl.
- Config: each package ships `config.schema.ts` (Zod) + `config.defaults.yaml`. The `config-loader` package discovers both at boot, merges with `config/env/<env>.yaml` overrides, validates, and hands typed slices to each service.
- `composition.ts` at `apps/api` (and at each deployable in `services/`) is the **only** place that binds interfaces to concrete impls. No consumer code references an impl package directly.

## 4. Service interfaces

Every service package exposes its interface via `./interface` (types + abstract class + Zod schemas, no runtime weight) and one or more implementation subpath exports. Consumers (the API composition root and other services) import from `./interface`; concrete bindings happen only at the composition root.

| # | Package | Interface exported (`./interface`) | Initial impl subpaths |
|---|---------|-------------------------------------|------------------------|
| 1 | `db` | `DBService`, `Repository<T>`, `UnitOfWork` | `./postgres`, `./testing` |
| 2 | `auth` | `AuthService`, `Session`, `OtpProvider` | `./otp` (email-OTP + JWT), `./testing` |
| 3 | `signal-stack` | `SignalStackClient` | `./rest`, `./testing` |
| 4 | `jobs-stack` | `JobsStackClient` | `./rest`, `./testing` |
| 5 | `signal-processing-client` | `SignalProcessingClient` | `./http`, `./testing` |
| 6 | `storage` | `StorageService` | `./s3`, `./local`, `./testing` |
| 7 | `email` | `EmailService` | `./smtp` (or provider), `./testing` |
| 8 | `queue` | `QueueService` | `./bullmq`, `./testing` |
| 9 | `cache` | `CacheService` | `./redis`, `./memory` |
| 10 | `observability` | `Logger`, `Metrics`, `Tracer` | `./pino-otel-prom`, `./testing` |
| 11 | `config-loader` | `ConfigService` | `./fs` (file-system loader), `./testing` |
| 12 | `schema-service` | `SchemaService` | `./default`, `./testing` |

Shared primitives (`shared-primitives`): typed error hierarchy (`UpstreamError`, `ConfigError`, `AuthError`, `ValidationError`, `DomainError`), branded IDs (`AggregatorId`, `UserId`, `OrgId`), `Result<T,E>`, common DTO bases. No business logic lives here — it is the irreducible shared surface only.

**Rule:** a service package's `./interface` subpath may import only from `shared-primitives` and `zod`. This is enforced by a dependency-cruiser rule in CI.

## 5. Configuration surface

Each service package owns the shape of its own config: it ships a Zod schema (`config.schema.ts`) and a `config.defaults.yaml`. The `config-loader` package discovers these at boot across the workspace, merges with environment-specific overrides under `config/env/<env>.yaml`, validates the composite against the union schema, and exposes typed slices to each service.

**Per-package config (owned by the service):**

| Package | Controls |
|---|---|
| `db` | Connection URL, pool size, statement timeout, migration table |
| `auth` | OTP TTL, session/refresh TTLs, rate limits, JWT signing key ref, OTP provider selection |
| `signal-stack` | Base URL, auth header, per-endpoint paths, retry/timeout/CB |
| `jobs-stack` | Base URL + endpoints, retry/timeout |
| `signal-processing-client` | SPS base URL + endpoints, cache TTLs |
| `storage` | Bucket, region, signed-URL TTL, retention days |
| `email` | Provider, sender, templates dir |
| `queue` | Redis URL, queue names, concurrency, DLQ policy |
| `cache` | Redis URL, key prefix, default TTL |
| `observability` | Log level, OTel endpoint, Prom scrape config |
| `schema-service` | Active profile schema version, completion-% threshold (default 75%) |

**Domain config (owned by `apps/api` + `schema-service`):**

| File | Controls |
|---|---|
| `profiles.yaml` (consumed by `schema-service`) | Profile schema (Who I Am / What I Have / What I Want), required flags, types, options. Source for dynamic form + completion-% |
| `entities.yaml` (consumed by `apps/api`) | Entity types (seeker, provider, future types) and their field bindings |
| `onboarding.yaml` (consumed by `apps/api`) | `modes.bulk.enabled`, `modes.qr.enabled`, `modes.link.enabled`, CSV template refs |
| `features.yaml` (consumed by `apps/api` + `apps/web`) | Feature flags (beta gates, post-MVP staging) |

**Env overrides (ops-owned):** `config/env/{dev,staging,prod}.yaml` — a single merge point that can override any key from any package's defaults. Secrets come from env vars via `${VAR}` interpolation.

**Precedence (lowest → highest):** package defaults → domain YAML → `config/env/<env>.yaml` → env vars.

## 6. Epic taxonomy

### 6.1 Platform epics (P-01 … P-20, `type:epic`, `phase:0` default)

| ID | Epic |
|---|---|
| P-01 | Monorepo & Build System |
| P-02 | Shared Primitives & Interface Conventions |
| P-03 | `config-loader` package (ConfigService) |
| P-04 | `db` package (DBService + Postgres impl) |
| P-05 | `auth` package (AuthService + OTP impl) |
| P-06 | `signal-stack` package (SignalStackClient + REST impl) |
| P-07 | `jobs-stack` package (JobsStackClient + REST impl) |
| P-08 | `signal-processing-client` package |
| P-09 | `storage` package (StorageService + S3/local impls) |
| P-10 | `email` package (EmailService + provider impl) |
| P-11 | `queue` package (QueueService + BullMQ impl) |
| P-12 | `cache` package (CacheService + Redis impl) |
| P-13 | Observability |
| P-14 | SchemaService |
| P-15 | Security Baseline |
| P-16 | Signal Processing Service (standalone) |
| P-17 | Frontend Foundation |
| P-18 | QA Foundation |
| P-19 | DevEx & CI |
| P-20 | Security / DPDP Controls |

### 6.2 Product epics (Φ1 … Φ4)

| ID | Epic | JTBDs |
|---|---|---|
| Φ1 | Phase 1 — Registration & Profile | AG-0, AG-0c |
| Φ2 | Phase 2 — Onboarding | AG-1, AG-1a, AG-1b, AG-1c |
| Φ3 | Phase 3 — My Blue Dots | AG-0b, AG-2, AG-6 |
| Φ4 | Phase 4 — Hardening | — (perf, DPDP, a11y, beta) |

### 6.3 Post-MVP tracking epic

| ID | Epic |
|---|---|
| X-01 | Post-MVP Backlog (stubs for AG-0a, AG-3, AG-4, AG-5, AG-7, AG-8 + 8 Future Scope items) |

## 7. Feature breakdown

(Full list in §8 below; numbering mirrors the [approved breakdown in conversation](./). Tasks will be enumerated when drafting issue markdowns. Expected totals: ~24 epics, ~135 features, ~250–350 tasks.)

## 8. Labels, milestones, Projects v2

### Labels

- `type:epic` · `type:feature` · `type:task` · `type:bug` · `type:spike`
- `area:backend` · `area:frontend` · `area:db` · `area:auth` · `area:observability` · `area:config` · `area:security` · `area:qa` · `area:devex` · `area:sps`
- `phase:0` · `phase:1` · `phase:2` · `phase:3` · `phase:4` · `phase:post-mvp`
- `jtbd:AG-0` · `jtbd:AG-0b` · `jtbd:AG-0c` · `jtbd:AG-1` · `jtbd:AG-1a` · `jtbd:AG-1b` · `jtbd:AG-1c` · `jtbd:AG-2` · `jtbd:AG-6` (+ post-MVP)
- `priority:p0` · `priority:p1` · `priority:p2`
- `needs:decision` · `needs:upstream-confirmation` · `blocked`

### Milestones

`Phase 0 — Foundations`, `Phase 1 — Registration & Profile`, `Phase 2 — Onboarding`, `Phase 3 — My Blue Dots`, `Phase 4 — Hardening`, `Post-MVP Backlog`.

### Projects v2 — `Aggregator DPG — MVP`

Custom fields: Status, Phase, Area, JTBD, Priority, Estimate (ideal-days), Epic, Depends-on.

Views:
1. Board by Status
2. Table by Phase
3. Roadmap by Milestone
4. Board by Area (the "block by block" lens)
5. Table by Epic (hierarchy)
6. Blocked items

## 9. Issue templates

Stored at `.github/ISSUE_TEMPLATE/epic.md`, `feature.md`, `task.md`. Every feature lists:
- JTBD / user story
- Acceptance criteria
- **Configuration surface** (which `config/*.yaml` keys this feature reads/requires)
- Interfaces touched (from `core-interfaces`)
- Tests (unit mandatory; integration/e2e as applicable)
- Child tasks + dependencies
- Definition of Done (code, tests, docs, observability, a11y, DPDP)

## 10. Dependency philosophy

Product features `blockedBy` specific Platform issues. Canonical pairings:

- Any feature touching Postgres ← depends on P-04 (DBService + migrations for the relevant tables).
- Any feature calling upstream ← depends on P-06 / P-07 / P-08.
- Any feature reading derived signals ← depends on the specific P-16 feature that materialises it.
- Any feature with async work ← depends on P-11 QueueService.
- Any UI feature ← depends on P-17 Frontend Foundation.
- Every feature ← depends on P-02 (interfaces exist) + P-03 (config loaded) + P-13 (logger available).

## 11. Open items (carried forward; each becomes a `needs:*` labelled issue)

1. DPDP consent scope for SPS (PRD open item).
2. PII access legal basis for follow-ups (PRD open item).
3. Signals Stack source-mode attribution — confirmation required.
4. SPS placement (standalone vs embedded in Signals Stack).
5. OTP provider choice (reuse Signals Stack's vs own).
6. Compute model sign-off (recommend Option A materialised).
7. Profile-completion threshold (PRD says 75%; make configurable).
8. Multi-admin per aggregator (MVP assumes single).
9. Link/QR lifecycle (expiry, revocation, multi-use).
10. Export retention (default 7 days).

## 12. Full feature enumeration

The complete feature list per epic is captured verbatim in §D of the brainstorming conversation and will be reproduced in `docs/issues/`. Summary counts:

- **P-01 … P-20** Platform: 95 features
- **Φ1 … Φ4** Product: 30 features
- **X-01** Post-MVP: ~14 stubs
- **Total: ~139 features**, ~250–350 tasks.

## 13. Next steps

1. Create `docs/issues/` directory tree mirroring epic → feature → task hierarchy (one markdown file per issue).
2. Fill in all Phase 0 + Phase 1 features and tasks completely.
3. Fill in Phase 2–4 features; tasks iterated as Phase 0 lands.
4. User review of markdown drafts.
5. `gh` CLI push: create labels, milestones, project, issues, set parent/sub-issue relations, assign to project with field values.

---

## Appendix A — Feature list (condensed)

_(Full per-feature detail moves to `docs/issues/` markdowns; list here for traceability.)_

**Uniform per-package features** (implicit in each of P-04 … P-14; not re-listed below):
- `./interface` subpath: abstract class + DTOs + Zod schemas
- `./testing` subpath: in-memory fake for tests
- `config.schema.ts` + `config.defaults.yaml` for the package
- `package.json` subpath exports set up per convention (P-02.2)

### P-01 Monorepo & Build System
F-01.1 pnpm workspaces + turbo · F-01.2 TS strict + shared tsconfig · F-01.3 ESLint/Prettier + husky · F-01.4 CI (lint/typecheck/test/build) · F-01.5 Conventional commits + release tooling · F-01.6 Dockerfiles per deployable

### P-02 Shared Primitives & Interface Conventions
F-02.1 `shared-primitives` package: error hierarchy, branded IDs, `Result`, base DTOs · F-02.2 Per-service package template (folder layout, subpath exports, `package.json` conventions) · F-02.3 Dependency-cruiser rule: `./interface` may import only `shared-primitives` + `zod` · F-02.4 Dependency-cruiser rule: no service may import another service's impl subpath · F-02.5 Interface authoring conventions (abstract class + Zod + DTO naming) · F-02.6 Testing-subpath conventions (fakes vs mocks)

Note: each service's interfaces are authored in that service's own package under P-04 … P-14. This epic covers only cross-cutting primitives and conventions that all services follow.

### P-03 `config-loader` package
F-03.1 `ConfigService` interface + FS loader impl · F-03.2 Per-package schema discovery mechanism · F-03.3 Env-YAML merge (`config/env/<env>.yaml`) · F-03.4 Env-var `${VAR}` interpolation · F-03.5 Composite Zod validation + typed slice accessors · F-03.6 Domain YAMLs: `profiles.yaml` · F-03.7 `entities.yaml` · F-03.8 `onboarding.yaml` · F-03.9 `features.yaml` · F-03.10 Hot-reload (dev) vs boot-only (prod) · F-03.11 Precedence + overrides docs

Note: each service package owns its own `config.schema.ts` and `config.defaults.yaml`; those features are listed under each service's epic (P-04 … P-14), not here.

### P-04 DBService (Postgres)
F-04.1 Postgres adapter · F-04.2 Migration runner · F-04.3 Schema (all README §5.3 tables) · F-04.4 Repositories per entity · F-04.5 UoW/transactions · F-04.6 Pool + health · F-04.7 Indexes · F-04.8 Seed scripts

### P-05 AuthService
F-05.1 JWT issuer/verifier · F-05.2 OTP gen/verify · F-05.3 OtpProvider email impl · F-05.4 OtpProvider SMS (stub) · F-05.5 Session middleware + aggregator scoping · F-05.6 Rate limits · F-05.7 Refresh rotation + revocation

### P-06 SignalStackClient
F-06.1 Typed client scaffold · F-06.2 Org lookup · F-06.3 Member list · F-06.4 Profile read · F-06.5 Bulk-create seeker/provider · F-06.6 Retry/backoff/CB · F-06.7 Contract tests · F-06.8 Source-mode attribution (upstream dep)

### P-07 JobsStackClient
F-07.1 Client scaffold · F-07.2 Postings read · F-07.3 Applications read · F-07.4 Status mapping · F-07.5 Retry/backoff · F-07.6 Contract tests

### P-08 SignalProcessingClient
F-08.1 Client scaffold · F-08.2 Summary binding · F-08.3 Participants binding · F-08.4 Detail binding

### P-09 StorageService
F-09.1 Interface + local-disk dev impl · F-09.2 S3/GCS impl · F-09.3 Signed URL TTL · F-09.4 Purge/retention job

### P-10 EmailService
F-10.1 Interface + templating · F-10.2 Provider impl · F-10.3 Registration/approval templates · F-10.4 Webhook ingest (bounces)

### P-11 QueueService
F-11.1 Interface · F-11.2 BullMQ impl · F-11.3 Worker entrypoints · F-11.4 DLQ + retry policy

### P-12 CacheService
F-12.1 Interface · F-12.2 Redis impl · F-12.3 Key schemes + TTL conventions

### P-13 Observability
F-13.1 pino logger + context · F-13.2 Request ID middleware · F-13.3 Prom metrics + HTTP histogram · F-13.4 OTel tracer + upstream spans · F-13.5 Dashboards + alerts · F-13.6 Audit log writer

### P-14 SchemaService
F-14.1 Schema versioning · F-14.2 Form descriptor emitter · F-14.3 Completion-% calculator · F-14.4 Required/optional resolution

### P-15 Security Baseline
F-15.1 TLS/HSTS · F-15.2 CSRF · F-15.3 CSP · F-15.4 CSV virus scan + limits · F-15.5 Signed URL TTLs · F-15.6 Secrets management

### P-16 Signal Processing Service
F-16.1 Scaffolding + Dockerfile · F-16.2 Ingestion jobs · F-16.3 Materialisation store · F-16.4 Seeker status rules · F-16.5 Provider status rules · F-16.6 Completion-% mat · F-16.7 Mode-wise reg counts · F-16.8 Aggregator summary · F-16.9 Read API · F-16.10 Refresh scheduler · F-16.11 Consumer-agnostic contract tests

### P-17 Frontend Foundation
F-17.1 Next.js scaffold · F-17.2 UI library + design tokens · F-17.3 TanStack Query + typed client · F-17.4 Auth context + protected routes · F-17.5 Schema-driven form renderer · F-17.6 Table/list primitive · F-17.7 i18n (next-intl) · F-17.8 A11y primitives + lint

### P-18 QA Foundation
F-18.1 Fixture strategy · F-18.2 Mock servers (Prism) · F-18.3 Test DB lifecycle · F-18.4 Playwright setup · F-18.5 Coverage gates · F-18.6 Visual regression baseline

### P-19 DevEx & CI
F-19.1 Branch protections · F-19.2 PR templates · F-19.3 CODEOWNERS · F-19.4 Preview deploys · F-19.5 Renovate

### P-20 Security / DPDP Controls
F-20.1 Audit-log viewer · F-20.2 Consent ledger · F-20.3 Retention jobs · F-20.4 PII redaction utils · F-20.5 Data-subject request tooling (stub)

### Φ1 Phase 1 — Registration & Profile
F1.1 AG-0 reg landing · F1.2 AG-0 API + email · F1.3 Approval confirmation email · F1.4 Login + session · F1.5 AG-0c profile view · F1.6 AG-0c profile edit · F1.7 Verified flag surfacing · F1.8 i18n scaffolding

### Φ2 Phase 2 — Onboarding
F2.1 Onboard landing/health card · F2.2 Link creation API · F2.3 QR generation · F2.4 Per-link/mode counts · F2.5 Config gate for modes · F2.6 CSV templates · F2.7 Bulk upload API · F2.8 Bulk orchestrator via Queue · F2.9 Batch status page · F2.10 Flagged list · F2.11 Follow-up intent logging

### Φ3 Phase 3 — My Blue Dots
F3.1 Summary cards · F3.2 Participant list · F3.3 Participant detail drawer (PII-gated) · F3.4 Status/follow-up rendering · F3.5 CSV export · F3.6 Export polling + signed URL

### Φ4 Phase 4 — Hardening
F4.1 Perf test suite · F4.2 DPDP final pass · F4.3 WCAG 2.1 AA audit · F4.4 Beta rollout + flags · F4.5 Load/chaos tests · F4.6 Runbook + on-call

### X-01 Post-MVP Backlog (stubs)
AG-0a self-service reg status · AG-3 in-app connection notifications · AG-4 direct outreach · AG-5 Aggregator-of-Aggregators · AG-7 NL queries · AG-8 ad-hoc reports · FS-1…FS-8 Future Scope items (contact write-back, unstructured bulk, credential issuance, voice-call onboarding, lifecycle mgmt, RBAC tiers, etc.)
