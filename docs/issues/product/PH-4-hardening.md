---
name: Epic
about: Φ4 Phase 4 — Hardening
title: "[EPIC] Φ4 Phase 4 — Hardening"
labels: ["type:epic", "phase:4", "area:qa", "area:security", "priority:p1"]
milestone: "Phase 4 — Hardening"
---

## Summary
Final MVP pass: performance validation against README §7.5, DPDP controls finalisation, WCAG 2.1 AA audit + remediation, beta rollout wiring, load/chaos testing on SPS refresh, runbook + on-call docs.

## Scope
**In scope:** perf test suite; DPDP final pass (consent, retention, PII gating); a11y audit + fixes; beta feature flags + rollout playbook; load/chaos tests on SPS; runbook/on-call docs.
**Out of scope:** Post-MVP features.

## Child features
- [ ] F4.1 Perf test suite + targets (README §7.5)
- [ ] F4.2 DPDP controls final pass (consent, retention, PII gating)
- [ ] F4.3 WCAG 2.1 AA audit + fixes
- [ ] F4.4 Beta rollout playbook + feature flags wiring
- [ ] F4.5 Load/chaos tests on SPS refresh
- [ ] F4.6 Runbook + on-call docs

## Success criteria
- All perf targets in README §7.5 met at p95
- Zero WCAG 2.1 AA blockers on the four main surfaces
- Runbook covers upstream outage, SPS refresh failure, DLQ drain

## Dependencies
- All prior phases

## Labels / milestone
- Labels: `type:epic`, `phase:4`, `area:qa`, `area:security`, `priority:p1`
- Milestone: `Phase 4 — Hardening`
