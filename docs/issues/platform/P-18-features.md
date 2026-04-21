# P-18 QA Foundation — features

---

## F-18.1 Fixture strategy

**AC**
- [ ] `packages/test-fixtures` with builders for domain entities (Aggregator, Seeker, Provider, Link, BulkBatch)
- [ ] Deterministic IDs + timestamps (seedable RNG)

**Tasks**
- [ ] T-18.1.1 Builder pattern
- [ ] T-18.1.2 Deterministic helpers

---

## F-18.2 Mock servers (Prism) for upstream APIs

**AC**
- [ ] `docker compose` service `prism-signal-stack` + `prism-jobs-stack` + `prism-sps` (P-16 fake)
- [ ] CI starts these services for integration tests
- [ ] Local dev command to boot them

**Tasks**
- [ ] T-18.2.1 Compose file
- [ ] T-18.2.2 CI wiring
- [ ] T-18.2.3 Dev doc

---

## F-18.3 Test DB lifecycle

**AC**
- [ ] Per-suite schema: create → migrate → run → drop
- [ ] Parallel suites do not collide
- [ ] CLI: `pnpm --filter db test:setup`

**Tasks**
- [ ] T-18.3.1 Schema manager
- [ ] T-18.3.2 Parallelism isolation

---

## F-18.4 Playwright setup + auth fixture

**AC**
- [ ] `apps/web-e2e` package with Playwright
- [ ] `authedContext` fixture obtains a JWT via `apps/api` test helper and attaches it
- [ ] Runs headless in CI, headed locally on demand

**Tasks**
- [ ] T-18.4.1 Playwright scaffold
- [ ] T-18.4.2 Auth fixture
- [ ] T-18.4.3 CI workflow

---

## F-18.5 Coverage gates

**AC**
- [ ] Per-package thresholds in `vitest.config.ts` (lines ≥ 80, branches ≥ 70 baseline; higher for `shared-primitives`)
- [ ] CI fails on regression; coverage report uploaded as artifact

**Tasks**
- [ ] T-18.5.1 Config
- [ ] T-18.5.2 CI report upload

---

## F-18.6 Visual regression baseline

**AC**
- [ ] Playwright + `@playwright/experimental-ct` (or Percy/Chromatic) for key pages: Login, Profile, Onboard landing, Blue Dots summary, Participant list
- [ ] Baselines committed; updates gated by explicit review step

**Tasks**
- [ ] T-18.6.1 Tooling choice
- [ ] T-18.6.2 Baselines
- [ ] T-18.6.3 Review process doc
