---
name: Epic
about: P-18 QA Foundation
title: "[EPIC] P-18 QA Foundation"
labels: ["type:epic", "phase:0", "area:qa", "priority:p1"]
milestone: "Phase 0 — Foundations"
---

## Summary
Testing infrastructure: fixture strategy, upstream mock servers (Prism), ephemeral test DB lifecycle, Playwright scaffolding, coverage gates, visual regression baseline.

## Scope
**In scope:** fixtures; Prism-based mocks for Signal/Jobs stacks; test DB setup/teardown; Playwright config; coverage thresholds enforced in CI; visual regression tooling for key pages.
**Out of scope:** Load/chaos testing (P-16 + Φ4).

## Child features
- [ ] F-18.1 Fixture strategy (domain objects, deterministic IDs)
- [ ] F-18.2 Mock servers (Prism) for upstream APIs
- [ ] F-18.3 Test DB lifecycle (per-suite schema drop/create)
- [ ] F-18.4 Playwright setup + auth fixture
- [ ] F-18.5 Coverage gates (per-package thresholds)
- [ ] F-18.6 Visual regression baseline

## Success criteria
- Unit + integration suites run in < 3 min locally
- E2E suite covers the four PRD flows from README §6

## Dependencies
- **Platform:** P-01, P-04, P-06, P-07, P-17

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:qa`, `priority:p1`
- Milestone: `Phase 0 — Foundations`
