---
name: Epic
about: P-10 email package (EmailService + provider impl)
title: "[EPIC] P-10 email package (EmailService + provider impl)"
labels: ["type:epic", "phase:0", "area:backend", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/email` provides `EmailService` for transactional email (OTP delivery, registration request notifications, approval confirmations). Ships a provider adapter (SES/SendGrid), templating, and webhook ingest for bounces/complaints.

## Scope
**In scope:** interface (`send`, `renderTemplate`); provider impl; template registry; webhook ingest; `./testing` in-memory sink; own config (provider, sender, templates dir).
**Out of scope:** Marketing/bulk mail.

## Child features
- [ ] F-10.1 `EmailService` interface + templating
- [ ] F-10.2 Provider adapter impl
- [ ] F-10.3 Transactional templates (OTP, reg request, approval)
- [ ] F-10.4 Webhook ingest (bounce / complaint)

## Success criteria
- All outbound mail goes through this package; no raw provider SDK imports elsewhere
- Templates rendered from a versioned registry; subject/body localised per `features.yaml` locale

## Dependencies
- **Platform:** P-01, P-02, P-03, P-13

## Open questions
- Provider choice (SES vs SendGrid vs Postmark). Defer to ops.

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
