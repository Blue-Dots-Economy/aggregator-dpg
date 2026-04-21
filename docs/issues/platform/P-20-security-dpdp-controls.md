---
name: Epic
about: P-20 Security / DPDP Controls
title: "[EPIC] P-20 Security / DPDP Controls"
labels: ["type:epic", "phase:0", "area:security", "priority:p1", "needs:decision"]
milestone: "Phase 0 — Foundations"
---

## Summary
DPDP-specific controls: audit-log viewer, consent ledger, retention jobs, PII redaction utilities, data-subject-request tooling stub. Final tightening happens in Φ4 once legal finalises; the plumbing lands in Phase 0.

## Scope
**In scope:** audit-log viewer (read-only in MVP); consent ledger schema + writer; retention purge jobs; PII redaction helpers used by logging; data-subject-request intake stub.
**Out of scope:** Consumer-facing privacy portal (post-MVP).

## Child features
- [ ] F-20.1 Audit-log viewer (read-only)
- [ ] F-20.2 Consent ledger (schema + write path)
- [ ] F-20.3 Retention purge jobs
- [ ] F-20.4 PII redaction utilities (used by logger/trace exporters)
- [ ] F-20.5 Data-subject-request intake stub

## Success criteria
- Every participant-detail view and every export is in the audit log with viewer identity
- No PII fields (name/phone/email) appear in logs unless explicitly whitelisted per route

## Dependencies
- **Platform:** P-04, P-11, P-13

## Open questions
- DPDP consent scope for SPS (PRD open item 1)
- PII access legal basis (PRD open item 2)

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:security`, `priority:p1`, `needs:decision`
- Milestone: `Phase 0 — Foundations`
