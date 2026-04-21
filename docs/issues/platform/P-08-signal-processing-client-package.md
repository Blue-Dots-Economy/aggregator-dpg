---
name: Epic
about: P-08 signal-processing-client package
title: "[EPIC] P-08 signal-processing-client package"
labels: ["type:epic", "phase:0", "area:backend", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/signal-processing-client` exposes the `SignalProcessingClient` interface and an HTTP adapter for the Signal Processing Service's read API. All Aggregator API reads of derived signals (summary, participants, detail) go through this package.

## Scope
**In scope:** interface + DTOs for aggregator-summary, participant list + filters, participant detail; HTTP adapter (`./http`); cache hooks; `./testing` fake; own config.
**Out of scope:** Computation logic (lives in P-16).

## Child features
- [ ] F-08.1 `SignalProcessingClient` interface + DTOs
- [ ] F-08.2 Summary endpoint binding
- [ ] F-08.3 Participants list binding (pagination, filters, search)
- [ ] F-08.4 Participant detail binding

## Success criteria
- No status-rule logic leaks into the Aggregator API — all labels come from SPS
- Pagination/filter/sort params are schema-validated before dispatch

## Dependencies
- **Platform:** P-01, P-02, P-03, P-13
- **Service dep:** P-16 SPS

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
