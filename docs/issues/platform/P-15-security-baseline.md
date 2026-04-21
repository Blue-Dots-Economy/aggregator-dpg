---
name: Epic
about: P-15 Security baseline
title: "[EPIC] P-15 Security baseline"
labels: ["type:epic", "phase:0", "area:security", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
Baseline security controls across the platform: TLS/HSTS, CSRF, CSP, CSV virus scanning + size/MIME limits, signed URL TTLs, secrets management. These are cross-cutting and land alongside P-04 … P-14 but are tracked separately for auditability.

## Scope
**In scope:** TLS/HSTS on all ingresses; CSRF on state-changing cookie-based endpoints; CSP headers; CSV scanning + streaming parse + limits; signed URL TTL conventions; secrets loaded from a secret store (not committed).
**Out of scope:** DPDP-specific controls (P-20 handles those).

## Child features
- [ ] F-15.1 TLS/HSTS baseline
- [ ] F-15.2 CSRF on state-changing endpoints
- [ ] F-15.3 CSP headers
- [ ] F-15.4 CSV virus scan + MIME/size limits
- [ ] F-15.5 Signed URL TTL conventions
- [ ] F-15.6 Secrets management (env / secret store)

## Success criteria
- `securityheaders.com` grade ≥ A
- No secret values in repo or in build logs

## Dependencies
- **Platform:** P-01, P-13

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:security`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
