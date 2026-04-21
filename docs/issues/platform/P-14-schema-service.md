---
name: Epic
about: P-14 schema-service package
title: "[EPIC] P-14 schema-service package"
labels: ["type:epic", "phase:0", "area:backend", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/schema-service` owns the Aggregator profile schema — loads from `profiles.yaml`, versions it, emits a form descriptor for the frontend, and computes profile completion-%. Single source of truth for "what is a profile field, is it required, and how is it rendered".

## Scope
**In scope:** interface (`getActiveSchema`, `getVersion`, `emitFormDescriptor`, `computeCompletionPct`); default impl; versioning (active/stored/migration); configurable completion threshold; `./testing` fake; own config.
**Out of scope:** DB-backed schema editing (deferred; schemas remain file-sourced in MVP).

## Child features
- [ ] F-14.1 Profile schema versioning (load, diff, publish)
- [ ] F-14.2 Dynamic form descriptor emitter (for frontend)
- [ ] F-14.3 Completion-% calculator
- [ ] F-14.4 Config-driven required/optional field resolution

## Success criteria
- Same completion-% function is used by SPS and the UI (no drift)
- Threshold (default 75%) configurable per aggregator in `profiles.yaml`

## Dependencies
- **Platform:** P-01, P-02, P-03

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
