# P-10 email package — features

---

## F-10.1 `EmailService` interface + templating

**AC**
- [ ] Interface: `send({ to, templateId, variables, locale, replyTo? })`
- [ ] Templates loaded from `packages/email/templates/<templateId>/<locale>.{subject.hbs,body.mjml}`
- [ ] Rendering uses handlebars (subject) + MJML (body → HTML)

**Tasks**
- [ ] T-10.1.1 Interface
- [ ] T-10.1.2 Template registry + loader
- [ ] T-10.1.3 Render pipeline

---

## F-10.2 Provider adapter impl

**AC**
- [ ] `./provider` adapter; provider selected via config (`email.provider = ses | sendgrid | postmark`)
- [ ] At least one concrete provider implemented for MVP
- [ ] Bounces/failures surfaced as typed errors

**Tasks**
- [ ] T-10.2.1 Provider interface
- [ ] T-10.2.2 One concrete provider
- [ ] T-10.2.3 Error mapping

---

## F-10.3 Transactional templates

**AC**
- [ ] Templates: `otp-login`, `registration-request-received`, `registration-approved`, `registration-rejected`
- [ ] English copy; placeholder locale directories present

**Tasks**
- [ ] T-10.3.1 `otp-login` templates
- [ ] T-10.3.2 Registration lifecycle templates

---

## F-10.4 Webhook ingest (bounce / complaint)

**AC**
- [ ] `POST /v1/webhooks/email` verifies provider signature, logs event, marks address as suppressed if bounce is permanent
- [ ] Suppressed addresses block outgoing send with a clear error

**Tasks**
- [ ] T-10.4.1 Webhook endpoint + signature verify
- [ ] T-10.4.2 Suppression list table (migration under P-04) + check in send path
