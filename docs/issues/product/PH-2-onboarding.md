---
name: Epic
about: Φ2 Phase 2 — Onboarding
title: "[EPIC] Φ2 Phase 2 — Onboarding"
labels: ["type:epic", "phase:2", "area:backend", "area:frontend", "priority:p0", "jtbd:AG-1", "jtbd:AG-1a", "jtbd:AG-1b", "jtbd:AG-1c"]
milestone: "Phase 2 — Onboarding"
---

## Summary
AG-1 (onboard via links/QR/bulk), AG-1a (per-mode conversion), AG-1b (act on flagged profiles), AG-1c (bulk-onboard participants). Config drives which modes surface: `onboarding.yaml: modes.bulk.enabled`, `.qr.enabled`, `.link.enabled`.

## Scope
**In scope:** onboard landing with overall-health card (SPS-sourced); signed link creation; QR image generation; per-link/mode join counts; CSV bulk upload with template validation; async orchestration via queue; per-row outcomes page; flagged-profiles list; follow-up intent logging.
**Out of scope:** Unstructured bulk upload (Future Scope); credential issuance on bulk create (Future Scope); in-app notifications on flagged (AG-3 post-MVP).

## Child features
- [ ] F2.1 Onboard landing + overall-health card (SPS-sourced)
- [ ] F2.2 Link creation API + signed-link generation
- [ ] F2.3 QR image generation (data URI)
- [ ] F2.4 Per-link/per-mode join counts display (SPS-sourced)
- [ ] F2.5 Config gate: bulk/QR/link toggles in `onboarding.yaml`
- [ ] F2.6 CSV template download (seeker + provider)
- [ ] F2.7 Bulk upload API: multipart + streaming parse + validation
- [ ] F2.8 Bulk upload orchestrator (queue → SignalStackClient.bulkCreate per row)
- [ ] F2.9 Batch status page + per-row outcomes
- [ ] F2.10 Flagged-profiles list (SPS-sourced)
- [ ] F2.11 Follow-up intent logging

## Success criteria
- Turning off `modes.bulk.enabled` hides the bulk UI and disables the endpoint (verified by test)
- Link/QR `aggregator_id` attribution round-trips to SPS mode-wise counts
- 1,000-row bulk upload completes in < 60 s per README §7.5

## Dependencies
- **Platform:** P-03, P-04, P-06, P-08, P-09, P-11, P-13, P-15, P-17
- **External:** Signals Stack source-mode attribution (PRD open item 3); Signal Processing Service (out of scope — consumed via P-08; see P-16 stub)

## Labels / milestone
- Labels: `type:epic`, `phase:2`, `area:backend`, `area:frontend`, `priority:p0`, `jtbd:AG-1`, `jtbd:AG-1a`, `jtbd:AG-1b`, `jtbd:AG-1c`
- Milestone: `Phase 2 — Onboarding`
