---
name: Epic
about: P-16 Signal Processing Service (standalone)
title: "[EPIC] P-16 Signal Processing Service (standalone)"
labels: ["type:epic", "phase:0", "area:sps", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`services/signal-processing` is the standalone service that ingests raw events from the Signals Stack and Jobs Stack, computes derived signals per README §3.2 and Appendix B, materialises them (Option A), and exposes a read API scoped by `aggregator_id`. No consumer (Aggregator API, future Ecosystem Manager) re-implements the rules.

## Scope
**In scope:** ingestion jobs; materialisation store (Postgres MVs to start); seeker & provider status rules; completion-% materialisation; mode-wise registration counts; aggregator summary; read API; refresh scheduler (5–15 min); contract tests that every consumer passes.
**Out of scope:** Streaming/online compute (Option B); natural-language/ad-hoc queries (post-MVP).

## Child features
- [ ] F-16.1 Service scaffolding + Dockerfile
- [ ] F-16.2 Ingestion jobs (pull from Signals Stack + Jobs Stack via P-06/P-07)
- [ ] F-16.3 Materialisation store (Postgres MVs)
- [ ] F-16.4 Seeker status rules (README Appendix B)
- [ ] F-16.5 Provider status rules (compound, README Appendix B)
- [ ] F-16.6 Profile completion-% materialisation
- [ ] F-16.7 Mode-wise registration counts (seeker + provider)
- [ ] F-16.8 Aggregator summary materialisation
- [ ] F-16.9 Read API (`/aggregators/:id/...`)
- [ ] F-16.10 Refresh scheduler (5–15 min cadence)
- [ ] F-16.11 Consumer-agnostic contract tests

## Success criteria
- Read API matches `SignalProcessingClient` interface exactly
- Refresh lag observable via metrics; alerts fire > 30 min
- Status labels validated by fixture tests covering every rule branch

## Dependencies
- **Platform:** P-01, P-02, P-03, P-04, P-06, P-07, P-13

## Open questions
- Placement: standalone vs embedded in Signals Stack (PRD open item 4). Architect the API contract so placement can change without consumer changes.

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:sps`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
