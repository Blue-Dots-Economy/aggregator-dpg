# Φ2 Phase 2 — Onboarding — features

> JTBDs: AG-1 (onboard via links/QR/bulk), AG-1a (conversion per mode), AG-1b (flagged profiles), AG-1c (bulk-onboard). Config-driven mode toggles via `onboarding.yaml`.

---

## F2.1 Onboard landing + overall-health card

**Story:** As an aggregator admin, I want to see total registered / verified / discoverable counts so I know the state of my network at a glance.

**AC**
- [ ] `/onboard` page (protected)
- [ ] `GET /v1/onboard/summary` returns counts via `SignalProcessingClient.getOnboardSummary`
- [ ] Cards render: `registered`, `verified`, `discoverable`, `flagged`, mode-wise breakdown
- [ ] Skeleton loaders while fetching; error state with retry

**Config touched:** none new.

**Interfaces touched:** `SignalProcessingClient`, frontend table primitives.

**Tests**
- [ ] Unit: card renders with fixtures
- [ ] Integration: `/summary` returns SPS-shaped data
- [ ] E2E: page renders non-zero counts against SPS fake

**Tasks**
- [ ] T-2.1.1 `/v1/onboard/summary` endpoint
- [ ] T-2.1.2 Cards component
- [ ] T-2.1.3 Skeleton + error states
- [ ] T-2.1.4 E2E

**Blocked by:** P-08.2, P-16 (fake), P-17.1–.2

---

## F2.2 Link creation API + signed link

**Story:** As an aggregator admin, I want to create an onboarding link so participants can register attributing to me.

**AC**
- [ ] `POST /v1/onboard/links` accepts `{ targetRole: "seeker" | "provider", label, expiresAt? }`
- [ ] Server generates `link_id` (ULID), stores in `onboarding_link`, signs a URL including `aggregator_id` + `mode=link` + `link_id`
- [ ] Returns `{ linkId, url, expiresAt }`
- [ ] Blocked if `onboarding.yaml: modes.link.enabled = false` (returns `ValidationError` + hides in UI)
- [ ] Audit-logged

**Config touched:** `onboarding.yaml: modes.link.enabled`, `onboarding.link.ttlDays` (optional expiry default).

**Interfaces touched:** `DBService`, `AuditLog`, `ConfigService`.

**Tests**
- [ ] Unit: URL signer
- [ ] Integration: POST → row in `onboarding_link`; response URL parses correctly
- [ ] Integration: toggle off → endpoint returns error
- [ ] E2E: create link from UI → copy to clipboard

**Tasks**
- [ ] T-2.2.1 `/onboard/links` POST handler
- [ ] T-2.2.2 URL signer
- [ ] T-2.2.3 Config-gate middleware
- [ ] T-2.2.4 UI create-link modal

**Blocked by:** P-04.4.2, P-13.6, P-17.1–.2

---

## F2.3 QR generation (data URI)

**Story:** As an aggregator admin, I want a QR image for each link so I can print/share it offline.

**AC**
- [ ] `POST /v1/onboard/links` response includes `qrDataUri` when `onboarding.yaml: modes.qr.enabled = true`
- [ ] QR encodes the signed URL; size configurable
- [ ] Frontend renders QR + download (PNG) button
- [ ] Blocked if mode disabled

**Config touched:** `onboarding.yaml: modes.qr.enabled`, `onboarding.qr.sizePx`.

**Interfaces touched:** QR generation (qrcode npm lib, local to adapter).

**Tests**
- [ ] Unit: QR payload round-trip
- [ ] E2E: QR visible on link detail; download works

**Tasks**
- [ ] T-2.3.1 QR generator util
- [ ] T-2.3.2 Include in link POST response
- [ ] T-2.3.3 UI render + download

**Blocked by:** F2.2

---

## F2.4 Per-link/per-mode join counts (SPS-sourced)

**Story:** As an aggregator admin, I want to see how many participants joined via each link / each mode so I know what's working.

**AC**
- [ ] `GET /v1/onboard/links` returns list with `{ linkId, mode, label, createdAt, expiresAt, joinCount }`
- [ ] `joinCount` sourced from `SignalProcessingClient.getOnboardSummary().modeBreakdown` joined on `link_id`
- [ ] Mode-wise totals shown at top of the page

**Config touched:** none new.

**Interfaces touched:** `SignalProcessingClient`, `DBService`.

**Tests**
- [ ] Integration: list merges DB rows with SPS counts
- [ ] Integration: missing SPS data → count = 0 (no error)
- [ ] E2E: counts update after fixture reflects new joins

**Tasks**
- [ ] T-2.4.1 `GET /v1/onboard/links` endpoint
- [ ] T-2.4.2 Merge logic (DB + SPS)
- [ ] T-2.4.3 List UI
- [ ] T-2.4.4 Mode totals

**Blocked by:** F2.2, P-08.2

---

## F2.5 Config gate: bulk/QR/link toggles in `onboarding.yaml`

**Story:** As ops, I want to turn off an onboarding mode via config so a broken mode doesn't block the product.

**AC**
- [ ] `onboarding.yaml: modes.{bulk,qr,link}.enabled` toggles are wired
- [ ] UI: disabled modes are hidden from the onboard landing
- [ ] API: disabled modes reject requests with `ValidationError` code `mode-disabled`
- [ ] `GET /v1/features/onboarding` returns the current toggles (so UI can query once at boot)
- [ ] Change applies on restart (prod) or hot-reload (dev)

**Config touched:** `onboarding.yaml`.

**Interfaces touched:** `ConfigService`.

**Tests**
- [ ] Integration: toggle off → UI hides section, API rejects
- [ ] Integration: toggle on → normal behaviour

**Tasks**
- [ ] T-2.5.1 Toggle read helper
- [ ] T-2.5.2 `GET /v1/features/onboarding`
- [ ] T-2.5.3 Frontend bootstrap query
- [ ] T-2.5.4 API gate middleware factory

**Blocked by:** P-03 (all)

---

## F2.6 CSV template download (seeker + provider)

**Story:** As an aggregator admin, I want a CSV template per role so my bulk uploads match the expected format.

**AC**
- [ ] `GET /v1/onboard/bulk-uploads/template?role=seeker|provider` returns a CSV with headers matching the profile schema required/optional fields, plus example rows
- [ ] Headers match exactly what `F2.7` validator expects
- [ ] Hidden in UI when bulk disabled

**Config touched:** `profiles.yaml` (source of headers), `onboarding.yaml` (mode toggle).

**Interfaces touched:** `SchemaService`.

**Tests**
- [ ] Unit: template generator from schema
- [ ] Integration: downloaded CSV parses back to schema headers
- [ ] E2E: download link on UI works

**Tasks**
- [ ] T-2.6.1 Template generator
- [ ] T-2.6.2 Endpoint
- [ ] T-2.6.3 UI download link

**Blocked by:** P-14.2, F2.5

---

## F2.7 Bulk upload API — multipart + streaming + validation

**Story:** As an aggregator admin, I want to upload a CSV and have each row validated and forwarded to the Signals Stack.

**AC**
- [ ] `POST /v1/onboard/bulk-uploads?role=seeker|provider` accepts multipart upload (max 25 MB, per P-15.4)
- [ ] Streaming CSV parse; per-row Zod validation against the schema-derived row schema
- [ ] Creates a `bulk_upload_batch` row with status `queued`; writes `bulk_upload_row` per row with raw + validation outcome
- [ ] Returns `202` with `{ batchId }`; orchestrator (F2.8) picks it up
- [ ] Config-gated: bulk disabled → reject
- [ ] ClamAV scan (P-15.4) runs before parse
- [ ] Audit-logged

**Config touched:** `onboarding.yaml: modes.bulk.{enabled, maxRows}`.

**Interfaces touched:** `DBService`, `StorageService` (raw file archived), `QueueService` (enqueue orchestrator job), `SchemaService`.

**Tests**
- [ ] Unit: row validator
- [ ] Integration: 1,000 rows → batch row + N detail rows + queued job; < 60 s
- [ ] Integration: malformed CSV rejected cleanly
- [ ] Security: infected file blocked

**Tasks**
- [ ] T-2.7.1 Multipart + streaming parser
- [ ] T-2.7.2 Row-schema derivation from profile schema
- [ ] T-2.7.3 Batch + row persistence
- [ ] T-2.7.4 Virus scan integration
- [ ] T-2.7.5 Job enqueue
- [ ] T-2.7.6 Perf test for 1,000 rows

**Blocked by:** P-04.4.3, P-09, P-11, P-14, P-15.4, F2.5

---

## F2.8 Bulk upload orchestrator (queue → SignalStackClient)

**Story:** As the system, I want to call the Signals Stack bulk-create endpoint for valid rows and record per-row outcomes asynchronously.

**AC**
- [ ] BullMQ job `bulk-upload.process` reads a `batchId`, iterates valid rows, calls `SignalStackClient.bulkCreate{Seekers,Providers}` in chunks (size from config)
- [ ] Per-row outcome (success / upstream-error / validation-error) written to `bulk_upload_row`
- [ ] Batch `status` transitions `queued → processing → completed` (or `failed`)
- [ ] Retries per row on transient upstream errors; terminal errors recorded with code
- [ ] Completion metric + audit log entry

**Config touched:** `onboarding.yaml: bulk.chunkSize`, `bulk.upstreamRetries`.

**Interfaces touched:** `QueueService`, `SignalStackClient`, `DBService`, `AuditLog`, `Metrics`.

**Tests**
- [ ] Unit: chunker
- [ ] Integration: mixed success/fail rows → correct outcomes
- [ ] Integration: upstream 5xx → retry → eventual success
- [ ] Integration: upstream persistent failure → row flagged with code

**Tasks**
- [ ] T-2.8.1 Job handler
- [ ] T-2.8.2 Chunking + retry policy
- [ ] T-2.8.3 Outcome persistence
- [ ] T-2.8.4 Status transitions
- [ ] T-2.8.5 Metrics + audit

**Blocked by:** F2.7, P-06.6, P-11

---

## F2.9 Batch status page + per-row outcomes

**Story:** As an aggregator admin, I want to see progress + per-row success/failure after a bulk upload so I can fix rejected rows.

**AC**
- [ ] `/onboard/bulk-uploads/:batchId` page (protected)
- [ ] `GET /v1/onboard/bulk-uploads/:id` returns batch + paginated per-row outcomes
- [ ] Rows filterable by outcome (`success`, `validation-error`, `upstream-error`, `pending`)
- [ ] Auto-refresh while batch is `processing`
- [ ] Download-errors CSV action (only failed rows)

**Config touched:** none new.

**Interfaces touched:** `DBService` (batch + rows), frontend table primitive.

**Tests**
- [ ] Integration: status endpoint correct for mid-progress batch
- [ ] E2E: upload → watch → final counts match

**Tasks**
- [ ] T-2.9.1 `GET /v1/onboard/bulk-uploads/:id` endpoint
- [ ] T-2.9.2 Page + filters
- [ ] T-2.9.3 Auto-refresh hook
- [ ] T-2.9.4 Errors-CSV download
- [ ] T-2.9.5 E2E

**Blocked by:** F2.7, F2.8, P-17.6

---

## F2.10 Flagged-profiles list (SPS-sourced)

**Story:** As an aggregator admin, I want a list of profiles with completion < threshold or format issues so I can follow up.

**AC**
- [ ] `/onboard/flagged` page (protected)
- [ ] `GET /v1/onboard/flagged-profiles` proxies `SignalProcessingClient` results filtered to flagged
- [ ] Columns: name, completion %, missing required fields, last updated, action ("Log follow-up")
- [ ] Paginated + searchable

**Config touched:** `profiles.yaml: completeness.threshold` (used by SPS, surfaced read-only in UI).

**Interfaces touched:** `SignalProcessingClient`.

**Tests**
- [ ] Integration: list returns rows under threshold
- [ ] E2E: list renders against SPS fake fixtures

**Tasks**
- [ ] T-2.10.1 Endpoint proxy
- [ ] T-2.10.2 Page + columns
- [ ] T-2.10.3 E2E

**Blocked by:** P-08, P-14.3, P-17.6

---

## F2.11 Follow-up intent logging

**Story:** As the system, I want to log every "Follow up" click so Phase-3 can include it in reports even though we don't do outreach in MVP.

**AC**
- [ ] `POST /v1/onboard/flagged-profiles/:userId/follow-up-intent` persists an `audit_log` entry (`action = "follow-up.intent"`, `entity = user`, payload = `{ reason }`)
- [ ] UI row updates to "Intent logged" after click; idempotent within a day
- [ ] No actual outreach triggered

**Config touched:** none new.

**Interfaces touched:** `AuditLog`, `DBService`.

**Tests**
- [ ] Integration: two clicks same day → one audit entry
- [ ] E2E: click → UI state updates

**Tasks**
- [ ] T-2.11.1 Endpoint
- [ ] T-2.11.2 Idempotency key (`aggregator_id + user_id + date`)
- [ ] T-2.11.3 UI update
- [ ] T-2.11.4 E2E

**Blocked by:** F2.10, P-13.6
