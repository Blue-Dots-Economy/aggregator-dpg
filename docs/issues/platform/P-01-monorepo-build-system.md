---
name: Epic
about: P-01 Monorepo & Build System
title: "[EPIC] P-01 Monorepo & Build System"
labels: ["type:epic", "phase:0", "area:devex", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
Establish the monorepo foundation: pnpm workspaces + turbo pipeline, strict TypeScript, lint/format, CI, release tooling, and Dockerfiles. Every other epic depends on this landing first.

## Scope
**In scope:**
- pnpm workspaces, turbo, shared tsconfig base
- ESLint + Prettier + pre-commit hooks (husky + lint-staged)
- GitHub Actions CI: lint, typecheck, test, build
- Conventional commits + release tooling (changesets)
- Dockerfiles for `apps/api`, `apps/web`, `services/signal-processing`

**Out of scope:**
- Preview deploys (lives in P-19)
- Renovate (P-19)
- Branch protections (P-19)

## Child features
- [ ] F-01.1 pnpm workspaces + turbo pipeline
- [ ] F-01.2 TS strict + shared tsconfig base
- [ ] F-01.3 ESLint/Prettier + husky hooks
- [ ] F-01.4 CI workflow (lint/typecheck/test/build)
- [ ] F-01.5 Conventional commits + changesets
- [ ] F-01.6 Dockerfiles per deployable

## Success criteria
- `pnpm install && pnpm -w test && pnpm -w build` passes clean on a fresh clone
- PR CI runs in < 8 min
- Any package can be added with ≤ 10 lines of config

## Dependencies
- **Upstream:** none
- **Platform epics this depends on:** none (this is the root)

## Open questions
- Changesets vs release-please? Default to changesets unless objection.

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:devex`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
