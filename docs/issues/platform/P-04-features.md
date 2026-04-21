# P-04 db package (DBService + Postgres impl) — features

---

## F-04.1 `DBService` / `Repository<T>` / `UnitOfWork` interfaces

**AC**
- [ ] `packages/db/src/interface.ts` exports: `DBService` (`healthcheck`, `close`, `transaction(fn)`), generic `Repository<TEntity, TId>` (`getById`, `findOne(filter)`, `findMany(filter, paging)`, `create`, `update`, `delete`), `UnitOfWork`
- [ ] `Filter` and `Paging` types live in `shared-primitives`
- [ ] No SQL leaks through the interface

**Tasks**
- [ ] T-04.1.1 Interfaces + generic types
- [ ] T-04.1.2 Filter/Paging DTOs
- [ ] T-04.1.3 Unit-test the types (type-level tests)

---

## F-04.2 Postgres adapter + pool + health

**AC**
- [ ] `./postgres` impl using `pg` + connection pool
- [ ] Pool size, statement timeout configurable via `db` config
- [ ] `healthcheck()` returns Ok iff a simple `SELECT 1` succeeds within SLA
- [ ] Metrics: pool active/idle/waiting exported

**Tasks**
- [ ] T-04.2.1 Pool wrapper
- [ ] T-04.2.2 Healthcheck
- [ ] T-04.2.3 Pool metrics hookup

---

## F-04.3 Migration runner

**AC**
- [ ] Drizzle-kit (or node-pg-migrate) wired; migrations live in `packages/db/migrations`
- [ ] `pnpm --filter db migrate:up` / `migrate:down` / `migrate:status`
- [ ] CI runs a round-trip (up → down → up) on every PR that touches migrations

**Tasks**
- [ ] T-04.3.1 Tooling choice + scaffolding
- [ ] T-04.3.2 CLI scripts
- [ ] T-04.3.3 CI migration round-trip test

---

## F-04.4 Schema + migrations for README §5.3 tables

**AC**
- [ ] Tables: `aggregator_profile_schema`, `aggregator_profile`, `onboarding_link`, `bulk_upload_batch`, `bulk_upload_row`, `registration_request`, `export_job`, `audit_log`
- [ ] FKs + ON DELETE semantics documented
- [ ] Timestamps default `now()`; every row has `created_at`

**Tasks**
- [ ] T-04.4.1 `aggregator_profile_schema` + `aggregator_profile`
- [ ] T-04.4.2 `onboarding_link`
- [ ] T-04.4.3 `bulk_upload_batch` + `bulk_upload_row`
- [ ] T-04.4.4 `registration_request`
- [ ] T-04.4.5 `export_job`
- [ ] T-04.4.6 `audit_log`

---

## F-04.5 Repository classes per entity

**AC**
- [ ] One repo per table implementing `Repository<T, Id>`
- [ ] Repos export typed queries for hot paths (e.g., `OnboardingLinkRepo.countJoinsByLink`)
- [ ] All queries use parameterised SQL; no string concat

**Tasks**
- [ ] T-04.5.1–.8 One task per entity repo

---

## F-04.6 Transactions / UnitOfWork

**AC**
- [ ] `dbService.transaction(async (uow) => {...})` yields a UoW with per-repo handles
- [ ] Rollback on throw; commit on success
- [ ] Nested calls reuse the outer tx (SAVEPOINTs)

**Tasks**
- [ ] T-04.6.1 Tx scope implementation
- [ ] T-04.6.2 SAVEPOINT nesting
- [ ] T-04.6.3 Integration tests against real Postgres

---

## F-04.7 Indexes + partial indexes

**AC**
- [ ] `(aggregator_id, created_at)` on list-heavy tables
- [ ] Partial indexes: active schemas (`active = true`), non-revoked links
- [ ] `EXPLAIN` captured for top 5 queries; committed to `docs/db/explain-baselines.md`

**Tasks**
- [ ] T-04.7.1 Index migrations
- [ ] T-04.7.2 EXPLAIN baselines doc

---

## F-04.8 In-memory `./testing` fake

**AC**
- [ ] Implements the same interface; backed by `Map`s
- [ ] Passes the repo contract test suite (shared with `./postgres`)
- [ ] Used by `apps/api` integration tests that don't need real SQL

**Tasks**
- [ ] T-04.8.1 Fake implementation
- [ ] T-04.8.2 Shared contract test suite

---

## F-04.9 `config.schema.ts` + defaults

**AC**
- [ ] Keys: `db.url`, `db.poolSize`, `db.statementTimeoutMs`, `db.migrationsTable`, `db.ssl`
- [ ] Defaults sane for local dev; `db.url` typically interpolated from `${DATABASE_URL}`

**Tasks**
- [ ] T-04.9.1 Zod schema
- [ ] T-04.9.2 Defaults file

---

## F-04.10 Seed scripts

**AC**
- [ ] `pnpm --filter db seed` populates a sample aggregator + schema version
- [ ] Idempotent; safe to re-run

**Tasks**
- [ ] T-04.10.1 Seed script
- [ ] T-04.10.2 Idempotency guards
