# P-20 Security / DPDP Controls — features

---

## F-20.1 Audit-log viewer (read-only)

**AC**
- [ ] Admin-only page listing `audit_log` entries, filterable by actor / action / entity / date range
- [ ] Pagination; CSV export of the filtered list
- [ ] No mutation operations in MVP

**Tasks**
- [ ] T-20.1.1 `GET /v1/audit-log` API (aggregator-scoped)
- [ ] T-20.1.2 Frontend page
- [ ] T-20.1.3 CSV export (reuses Φ3 export plumbing)

---

## F-20.2 Consent ledger

**AC**
- [ ] `consent_ledger` table (migration under P-04) recording: `subject_id`, `purpose`, `scope`, `granted_at`, `revoked_at?`, `source`
- [ ] Service interface `ConsentLedger.record / list / revoke`
- [ ] Every write is append-only (no update; revocation adds a new row)

**Tasks**
- [ ] T-20.2.1 Migration + repo
- [ ] T-20.2.2 Service interface
- [ ] T-20.2.3 Admin UI (list-only in MVP)

---

## F-20.3 Retention purge jobs

**AC**
- [ ] Queue-scheduled jobs that purge: exports > 7 d, OTP challenges > 1 h, audit-log beyond configured retention (default: indefinite, flagged per DPDP guidance)
- [ ] Every purge logs a summary row to `audit_log`

**Tasks**
- [ ] T-20.3.1 Exports purge job (coordinated with P-09.4)
- [ ] T-20.3.2 OTP challenge purge job
- [ ] T-20.3.3 Audit-log retention policy (config-only in MVP)

---

## F-20.4 PII redaction utilities

**AC**
- [ ] `redact(obj, { allowFields })` masks non-allow-listed PII fields (`email`, `phone`, `name`, `address`) to `<redacted>`
- [ ] Wired as a pino serializer and an OTel span attribute processor
- [ ] Unit tests cover nested structures + arrays

**Tasks**
- [ ] T-20.4.1 Redactor
- [ ] T-20.4.2 pino serializer
- [ ] T-20.4.3 OTel processor

---

## F-20.5 Data-subject-request intake stub

Labels: `needs:decision`

**AC**
- [ ] Public form `/legal/dsar` (unauthenticated) captures request + contact
- [ ] Persisted to `dsar_request` table (migration under P-04)
- [ ] Admin notified via email
- [ ] No automated fulfilment in MVP; manual workflow documented

**Tasks**
- [ ] T-20.5.1 Form + persistence
- [ ] T-20.5.2 Admin notification
- [ ] T-20.5.3 Manual workflow doc
