---
name: Epic
about: Φ1 Phase 1 — Registration & Profile
title: "[EPIC] Φ1 Phase 1 — Registration & Profile"
labels: ["type:epic", "phase:1", "area:backend", "area:frontend", "priority:p0", "jtbd:AG-0", "jtbd:AG-0c"]
milestone: "Phase 1 — Registration & Profile"
---

## Summary
Deliver AG-0 (registration request + approval flow + login) and AG-0c (schema-driven profile view/edit + verified flag surfacing). This is the first end-to-end value increment for the Aggregator admin.

## Scope
**In scope:** pre-login registration landing + form; registration-request persistence + admin email; approval-confirmation email; email/phone OTP login; session issuance; aggregator profile view/edit rendered from the profile schema; verified-flag surfacing; i18n copy externalisation.
**Out of scope:** AG-0a (self-service registration status tracking — post-MVP); write-back of profile contact details to Signals Stack (Future Scope).

## Child features
- [ ] F1.1 AG-0 Registration-request landing page + form
- [ ] F1.2 AG-0 `POST /v1/registration-requests` + email-to-admin + persistence
- [ ] F1.3 AG-0 Approval-confirmation email template
- [ ] F1.4 AG-0 Login page (email/phone + OTP) + session issuance
- [ ] F1.5 AG-0c Profile view (dynamic render from `SchemaService`)
- [ ] F1.6 AG-0c Profile edit + save (Aggregator DB)
- [ ] F1.7 AG-0c Verified-flag surfacing from Signals Stack
- [ ] F1.8 i18n scaffolding + English copy externalisation

## Success criteria
- New aggregator admin can: submit a request → receive approval email → log in via OTP → see profile → edit fields → save
- `apps/web` reads the profile descriptor from `schema-service`; no hardcoded fields
- All user-visible strings externalised to i18n bundles

## Dependencies
- **Platform:** P-03, P-04, P-05, P-06, P-10, P-14, P-17

## Open questions
- Multi-admin per aggregator (PRD open item 8) — MVP assumes single

## Labels / milestone
- Labels: `type:epic`, `phase:1`, `area:backend`, `area:frontend`, `priority:p0`, `jtbd:AG-0`, `jtbd:AG-0c`
- Milestone: `Phase 1 — Registration & Profile`
