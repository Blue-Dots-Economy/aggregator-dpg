---
name: Epic
about: P-04 db package (DBService + Postgres impl)
title: "[EPIC] P-04 db package (DBService + Postgres impl)"
labels: ["type:epic", "phase:0", "area:db", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/db` ships the `DBService` / `Repository<T>` / `UnitOfWork` interfaces, a Postgres implementation at `./postgres` (pool + migrations + repositories), and an in-memory `./testing` fake. All persistence in the system flows through this package; callers never see SQL.

## Scope
**In scope:**
- `./interface`: `DBService`, `Repository<T>`, `UnitOfWork`, query/filter DTOs
- `./postgres`: pg adapter, pool, health check, transaction/UoW, repos per entity
- Migration runner (drizzle-kit or node-pg-migrate)
- Schema for all tables in README §5.3
- Indexes (aggregator_id, created_at) + partial indexes per README
- `./testing` in-memory fake
- `config.schema.ts` (connection URL, pool size, timeouts) + `config.defaults.yaml`
- Seed scripts for local dev

**Out of scope:**
- Any business logic (repos expose CRUD + scoped queries only)

## Child features
- [ ] F-04.1 `DBService` / `Repository<T>` / `UnitOfWork` interfaces
- [ ] F-04.2 Postgres adapter at `./postgres` + connection pool + health
- [ ] F-04.3 Migration runner
- [ ] F-04.4 Schema + migrations for README §5.3 tables
- [ ] F-04.5 Repository classes per entity
- [ ] F-04.6 Transactions / UnitOfWork
- [ ] F-04.7 Indexes + partial indexes
- [ ] F-04.8 In-memory `./testing` fake
- [ ] F-04.9 `config.schema.ts` + defaults
- [ ] F-04.10 Seed scripts for local dev

## Success criteria
- All repos pass the same contract test suite against both `./postgres` and `./testing`
- Migrations are reversible; rollback tested in CI
- No `apps/api` code imports `pg` directly

## Dependencies
- **Platform epics:** P-01, P-02, P-03

## Open questions
- Drizzle vs raw pg + node-pg-migrate? Drizzle gives typed queries; raw gives flexibility. Recommend Drizzle unless objection.

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:db`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
