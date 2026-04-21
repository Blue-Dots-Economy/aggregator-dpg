# P-01 Monorepo & Build System — features

> One H2 per feature. Each section becomes its own GitHub issue (`type:feature`). Labels/milestone are inherited from the parent epic unless overridden per section.

---

## F-01.1 pnpm workspaces + turbo pipeline

**Story:** As a developer, I want pnpm workspaces + turbo so adding a package and running builds is consistent.

**AC**
- [ ] Root `pnpm-workspace.yaml` covers `apps/*`, `services/*`, `packages/*`
- [ ] Root `turbo.json` defines `build`, `test`, `lint`, `typecheck`, `dev` pipelines
- [ ] `pnpm -w build` runs topologically and caches on re-run

**Tests:** CI runs `pnpm -w lint typecheck test build` on every PR.

**Tasks**
- [ ] T-01.1.1 Init pnpm + `pnpm-workspace.yaml`
- [ ] T-01.1.2 Install turbo; base pipeline
- [ ] T-01.1.3 Add `apps/api` + `apps/web` stubs to validate topology
- [ ] T-01.1.4 Document in `CONTRIBUTING.md`

---

## F-01.2 TS strict + shared tsconfig base

**Story:** As a developer, I want a shared `tsconfig.base.json` so every package enforces strict typing identically.

**AC**
- [ ] `packages/tsconfig/base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- [ ] Every workspace package extends it via `"extends": "@acme/tsconfig/base"`
- [ ] A canary type error in any package fails `pnpm -w typecheck`

**Tests:** fixture: intentional type violation → CI fails.

**Tasks**
- [ ] T-01.2.1 Create `packages/tsconfig` with base + `node` and `next` variants
- [ ] T-01.2.2 Wire all existing stubs to extend base
- [ ] T-01.2.3 Add canary test in CI

---

## F-01.3 ESLint/Prettier + husky hooks

**Story:** As a developer, I want consistent lint/format + pre-commit hooks so style debates stop at the keyboard.

**AC**
- [ ] Shared `eslint.config.js` + `prettier.config.js` at root
- [ ] `eslint-plugin-jsx-a11y` wired for `apps/web`
- [ ] husky + lint-staged run format + lint on staged files
- [ ] `pnpm -w lint` exits clean on fresh scaffold

**Tests:** CI job `lint`; local pre-commit fails on a violation (manual verify).

**Tasks**
- [ ] T-01.3.1 Install ESLint + plugins; author shared config
- [ ] T-01.3.2 Prettier config + `.prettierignore`
- [ ] T-01.3.3 husky install + `lint-staged` wiring
- [ ] T-01.3.4 Document bypass discouragement in `CONTRIBUTING.md`

---

## F-01.4 CI workflow (lint / typecheck / test / build)

**Story:** As a maintainer, I want one GH Actions workflow that gates every PR on lint, typecheck, test, and build.

**AC**
- [ ] `.github/workflows/ci.yml` runs on `pull_request` + `push` to `main`
- [ ] Caches pnpm store + turbo remote cache
- [ ] Matrix: Node LTS (20, 22)
- [ ] Total runtime < 8 min on green

**Tests:** CI itself; a PR with a broken test must fail.

**Tasks**
- [ ] T-01.4.1 Author `ci.yml` with `setup-pnpm` + caches
- [ ] T-01.4.2 Add Node version matrix
- [ ] T-01.4.3 Turbo remote cache (signed-in action) for PR perf
- [ ] T-01.4.4 Required-status-checks list pinned

---

## F-01.5 Conventional commits + changesets

**Story:** As a release manager, I want conventional commits + changesets so versioning and changelogs are mechanical.

**AC**
- [ ] `@changesets/cli` wired; `pnpm changeset` adds an entry
- [ ] commitlint enforces conventional commit style
- [ ] Release workflow publishes packages + tags on `main`

**Tests:** commitlint fails a malformed commit message in CI.

**Tasks**
- [ ] T-01.5.1 Install changesets + init
- [ ] T-01.5.2 commitlint config + husky hook
- [ ] T-01.5.3 Release workflow (manual trigger first)

---

## F-01.6 Dockerfiles per deployable

**Story:** As an operator, I want Dockerfiles for `apps/api`, `apps/web`, and each `services/*` so each ships as an immutable image.

**AC**
- [ ] `apps/api/Dockerfile`, `apps/web/Dockerfile` with multi-stage build using pnpm workspace pruning (`pnpm deploy`)
- [ ] Images run under a non-root user; no secrets baked in
- [ ] CI builds images on PR (no push); publishes on `main`

**Tests:** `docker build` for each image runs in CI; smoke test: `docker run` passes `/health`.

**Tasks**
- [ ] T-01.6.1 Dockerfile for `apps/api` (multi-stage, pnpm deploy)
- [ ] T-01.6.2 Dockerfile for `apps/web`
- [ ] T-01.6.3 Dockerfile skeleton for `services/*`
- [ ] T-01.6.4 CI steps for build + optional push
