---
name: Epic
about: Φ3 Phase 3 — My Blue Dots
title: "[EPIC] Φ3 Phase 3 — My Blue Dots"
labels: ["type:epic", "phase:3", "area:backend", "area:frontend", "priority:p0", "jtbd:AG-0b", "jtbd:AG-2", "jtbd:AG-6"]
milestone: "Phase 3 — My Blue Dots"
---

## Summary
The signal-heavy surface: aggregate summary cards (AG-0b), paginated participant list with status/filters (AG-2), PII-gated detail drawer, and CSV export as the MVP report (AG-6). All status labels and counts come from the Signal Processing Service — no client-side derivation.

## Scope
**In scope:** summary cards for seekers + providers; participant list (paginated, searchable, filterable by status); detail drawer with audit-logged PII access; CSV export (sync ≤ 10k, async via queue above); export-job status polling; signed download URL.
**Out of scope:** AG-5 Aggregator-of-Aggregators; AG-7/AG-8 NL queries and ad-hoc reports.

## Child features
- [ ] F3.1 AG-0b Summary cards (status counts, participation metrics, new-in-7-days)
- [ ] F3.2 AG-2 Participant list (paginated, searchable, filterable)
- [ ] F3.3 AG-2 Participant detail drawer (PII-gated, audit-logged)
- [ ] F3.4 AG-2 Status & follow-up column rendering (server-provided)
- [ ] F3.5 AG-6 CSV export (sync ≤ 10k, async above)
- [ ] F3.6 AG-6 Export-job status polling + signed download URL

## Success criteria
- Participant list page (50 rows) loads in < 800 ms at p95 per README §7.5
- Every participant-detail open and every export is audit-logged (P-13 F-13.6)
- Toggling a status rule in SPS updates the UI with no web deploy

## Dependencies
- **Platform:** P-08, P-09, P-11, P-13, P-16, P-17, P-20

## Labels / milestone
- Labels: `type:epic`, `phase:3`, `area:backend`, `area:frontend`, `priority:p0`, `jtbd:AG-0b`, `jtbd:AG-2`, `jtbd:AG-6`
- Milestone: `Phase 3 — My Blue Dots`
