---
name: Epic
about: P-05 auth package (AuthService + OTP impl)
title: "[EPIC] P-05 auth package (AuthService + OTP impl)"
labels: ["type:epic", "phase:0", "area:auth", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/auth` provides `AuthService` and `OtpProvider` interfaces, a `./otp` implementation (OTP generation/verify + JWT access/refresh), session middleware that enforces `aggregator_id` scoping, and rate limits. Ships an email-OTP impl; SMS provider is a sub-interface pluggable later.

## Scope
**In scope:** AuthService/OtpProvider interfaces; JWT issue/verify; OTP flow; email OTP provider; session middleware; refresh rotation + revocation; rate limits; `./testing` fake; own config schema.
**Out of scope:** RBAC beyond single `aggregator_admin` role (post-MVP); SSO.

## Child features
- [ ] F-05.1 JWT issuer/verifier (short-lived access + rotating refresh)
- [ ] F-05.2 OTP generation/verification
- [ ] F-05.3 `OtpProvider` email impl
- [ ] F-05.4 `OtpProvider` SMS stub (`needs:decision`)
- [ ] F-05.5 Session middleware + aggregator_id scoping
- [ ] F-05.6 Rate limits on OTP endpoints
- [ ] F-05.7 Refresh-token rotation + revocation store

## Success criteria
- No endpoint in `apps/api` can be accessed without `AuthService` verifying the session
- `session.aggregator_id` is the only source for scoping; clients cannot supply it

## Dependencies
- **Platform:** P-01, P-02, P-03, P-04 (revocation store), P-10 (email for OTP)

## Open questions
- OTP delivery provider (Q5 still pending PM sign-off).

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:auth`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
