---
name: Epic
about: P-19 DevEx & CI
title: "[EPIC] P-19 DevEx & CI"
labels: ["type:epic", "phase:0", "area:devex", "priority:p1"]
milestone: "Phase 0 — Foundations"
---

## Summary
Developer experience: branch protections, PR templates, CODEOWNERS, preview deploys, Renovate for dependencies. Complements P-01 which handles the baseline build pipeline.

## Scope
**In scope:** branch protections + required checks; PR template; CODEOWNERS; preview deploys (Vercel or equivalent for web, ephemeral per-PR API); Renovate config.
**Out of scope:** Monorepo tooling (P-01).

## Child features
- [ ] F-19.1 Branch protections on `main`
- [ ] F-19.2 PR template + checklist
- [ ] F-19.3 CODEOWNERS
- [ ] F-19.4 Preview deploys per PR
- [ ] F-19.5 Renovate configuration

## Success criteria
- Main protected: required checks, ≥1 review, linear history
- Renovate batches minor deps weekly

## Dependencies
- **Platform:** P-01

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:devex`, `priority:p1`
- Milestone: `Phase 0 — Foundations`
