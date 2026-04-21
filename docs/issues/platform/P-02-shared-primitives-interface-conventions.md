---
name: Epic
about: P-02 Shared Primitives & Interface Conventions
title: "[EPIC] P-02 Shared Primitives & Interface Conventions"
labels: ["type:epic", "phase:0", "area:backend", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
Create the `packages/shared-primitives` package (error hierarchy, branded IDs, `Result`, base DTOs) and codify the conventions every service package must follow: folder layout, `package.json` subpath exports, `./interface`/`./testing` discipline, and CI rules that enforce them.

## Scope
**In scope:**
- `shared-primitives` package authored and published in-workspace
- A canonical per-service package template (documented + scaffold)
- dependency-cruiser rules wired into CI

**Out of scope:**
- Any specific service's interface (those land in P-04 … P-14)
- Business logic (shared-primitives contains no domain logic)

## Child features
- [ ] F-02.1 `shared-primitives` package: error hierarchy, branded IDs, `Result`, base DTOs
- [ ] F-02.2 Per-service package template (layout, subpath exports, `package.json`)
- [ ] F-02.3 Dependency-cruiser rule: `./interface` may import only `shared-primitives` + `zod`
- [ ] F-02.4 Dependency-cruiser rule: no service may import another service's impl subpath
- [ ] F-02.5 Interface authoring conventions (abstract class + Zod + DTO naming)
- [ ] F-02.6 Testing-subpath conventions (fakes vs mocks)

## Success criteria
- Any new service can be scaffolded by copying the template and editing one config
- CI fails any PR that violates the import rules
- `shared-primitives` has < 300 LOC and zero runtime deps beyond `zod`

## Dependencies
- **Platform epics this depends on:** P-01

## Open questions
- Branded ID scheme: nominal types via `Brand<T, 'Name'>` vs opaque class wrappers? Default to branded types.

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
