# Φ3 Phase 3 — My Blue Dots — features

> JTBDs: AG-0b (participant dashboard), AG-2 (connection activity + prioritise follow-up), AG-6 (aggregated summary export). All status labels + counts come from SPS; no client-side computation.

---

## F3.1 AG-0b Summary cards

**Story:** As an aggregator admin, I want status-bucket counts, participation metrics, and new-in-7-days so I can see network health at a glance.

**AC**
- [ ] `/blue-dots` page (protected) renders seeker + provider summary sections
- [ ] `GET /v1/blue-dots/summary` proxies `SignalProcessingClient.getBlueDotsSummary`
- [ ] Seeker cards: New / Active / At Risk / Inactive counts; avg completion %; % with ≥ 1 application; new-in-7-days
- [ ] Provider cards: New / Satisfied / Active / At Risk / Inactive counts; openings; new-in-7-days
- [ ] Skeleton loaders; error state with retry; empty state

**Config touched:** none new.

**Interfaces touched:** `SignalProcessingClient`.

**Tests**
- [ ] Unit: card renders per status fixture
- [ ] Integration: endpoint returns SPS-shaped summary
- [ ] E2E: page renders against SPS fake with each status present

**Tasks**
- [ ] T-3.1.1 `/v1/blue-dots/summary` endpoint
- [ ] T-3.1.2 Seeker + provider cards components
- [ ] T-3.1.3 Empty + error states
- [ ] T-3.1.4 E2E

**Blocked by:** P-08.2, P-16 (fake), P-17.1–.2

---

## F3.2 AG-2 Participant list (paginated, searchable, filterable)

**Story:** As an aggregator admin, I want a participant list with search + filters so I can find people to follow up on.

**AC**
- [ ] `/blue-dots/participants` page (protected)
- [ ] `GET /v1/blue-dots/participants` proxies `SignalProcessingClient.listParticipants` with query params: `cursor`, `limit`, `q` (search by name), `statusSeeker`, `statusProvider`, `profileStatus`, `sort`
- [ ] Columns: name, role (seeker/provider), date joined, profile completion %, application status counts (applied / shortlisted / rejected / pending), computed status, recommended follow-up
- [ ] Filter pills + search input; keyboard-navigable (P-17.6 primitive)
- [ ] Page size 50; cursor pagination; perf target < 800 ms p95 (README §7.5)

**Config touched:** none new.

**Interfaces touched:** `SignalProcessingClient`, frontend table primitive.

**Tests**
- [ ] Integration: filter + search + sort round-trip
- [ ] Integration: pagination cursor stable
- [ ] E2E: apply a status filter → list updates
- [ ] Perf: 50-row page under 800 ms against SPS fake in CI

**Tasks**
- [ ] T-3.2.1 `/v1/blue-dots/participants` endpoint
- [ ] T-3.2.2 Filter/search UI
- [ ] T-3.2.3 Sort controls
- [ ] T-3.2.4 Table integration (P-17.6)
- [ ] T-3.2.5 E2E + perf assert

**Blocked by:** P-08.3, P-17.6

---

## F3.3 AG-2 Participant detail drawer (PII-gated, audit-logged)

**Story:** As an aggregator admin, I want to open a participant's detail so I can decide on follow-up; every view is audit-logged per DPDP.

**AC**
- [ ] Click on a row opens a right-hand drawer (keyboard-dismissible)
- [ ] `GET /v1/blue-dots/participants/:userId` proxies `SignalProcessingClient.getParticipant`
- [ ] Response contains PII (name, phone, email); endpoint is marked `@audited` so the route middleware records an audit-log entry before response (`action = "participant.detail.viewed"`, `entity = user`)
- [ ] UI shows PII fields with copy-to-clipboard buttons (no masking in MVP; DPDP final pass in Φ4)
- [ ] Drawer state reflected in URL so it's shareable + back-button works

**Config touched:** none new.

**Interfaces touched:** `SignalProcessingClient`, `AuditLog` middleware.

**Tests**
- [ ] Integration: open → response has PII + audit log row
- [ ] Integration: repeat opens within 60 s → one audit row (config-driven dedup)
- [ ] E2E: keyboard nav + close
- [ ] Accessibility: axe-core clean

**Tasks**
- [ ] T-3.3.1 `/v1/blue-dots/participants/:userId` endpoint with `@audited` marker
- [ ] T-3.3.2 Drawer component
- [ ] T-3.3.3 URL state sync
- [ ] T-3.3.4 Audit-log lint rule verification
- [ ] T-3.3.5 E2E + axe

**Blocked by:** P-08.4, P-13.6, P-17.1–.2

---

## F3.4 AG-2 Status & follow-up column rendering

**Story:** As an aggregator admin, I want the computed status + recommended follow-up presented clearly so I can act without re-reading the rules.

**AC**
- [ ] Status rendered as a coloured badge keyed to the enum value (no client-side computation; label comes straight from SPS)
- [ ] `followUp` column shows the SPS-provided recommendation verbatim; blank when none
- [ ] Tooltip on each badge links to the rules doc (README Appendix B)

**Config touched:** none new.

**Interfaces touched:** frontend only; relies on F3.2 endpoint.

**Tests**
- [ ] Unit: every status value renders a badge (fixture table)
- [ ] Visual regression: badges render correctly (P-18.6)

**Tasks**
- [ ] T-3.4.1 Badge component
- [ ] T-3.4.2 Tooltip link
- [ ] T-3.4.3 Visual baselines

**Blocked by:** F3.2, P-18.6

---

## F3.5 AG-6 CSV export

**Story:** As an aggregator admin, I want to export the current filtered list as CSV so I can share a report with the ecosystem manager.

**AC**
- [ ] `POST /v1/blue-dots/export` accepts the current filter set; creates an `export_job` row (status `queued`)
- [ ] Sync path for ≤ 10,000 result rows: endpoint streams CSV directly (< 30 s target)
- [ ] Async path for larger result sets: enqueue `export.generate` job; response returns `{ exportId }`; caller polls via F3.6
- [ ] Job streams results from `SignalProcessingClient.listParticipants` (cursor), writes to `StorageService`, updates `export_job` status → `ready`, sets `fileUrl` (signed URL, 1 h TTL)
- [ ] Audit-logged with filter snapshot + viewer
- [ ] Config-gated max rows: `features.yaml: exports.maxRows = 100000`

**Config touched:** `features.yaml: exports.{maxRows, syncRowLimit}`.

**Interfaces touched:** `SignalProcessingClient`, `QueueService`, `StorageService`, `DBService`, `AuditLog`.

**Tests**
- [ ] Integration: sync export for small set
- [ ] Integration: async export for > syncRowLimit
- [ ] Integration: filter snapshot reproduces the same rows on a second job
- [ ] Perf: 10k rows sync < 30 s

**Tasks**
- [ ] T-3.5.1 `POST /v1/blue-dots/export` handler (sync + async branch)
- [ ] T-3.5.2 `export.generate` queue job
- [ ] T-3.5.3 CSV stream writer
- [ ] T-3.5.4 Audit + filter snapshot
- [ ] T-3.5.5 Perf test

**Blocked by:** P-04.4.5, P-08.3, P-09, P-11, P-13.6

---

## F3.6 AG-6 Export-job status polling + signed download URL

**Story:** As an aggregator admin, I want to see the progress of a long export and download the result when ready.

**AC**
- [ ] `GET /v1/blue-dots/exports/:id` returns `{ status: queued|running|ready|failed, rowsProcessed?, fileUrl?, error? }`
- [ ] `fileUrl` is a signed `StorageService` URL, 1 h TTL; regenerable on a second poll after expiry
- [ ] UI: "Export" button opens a progress modal; polls every 2 s while `running`; offers download when `ready`
- [ ] Failed jobs surface the error class + retry button

**Config touched:** `features.yaml: exports.pollIntervalMs`.

**Interfaces touched:** `DBService` (`export_job`), `StorageService`.

**Tests**
- [ ] Integration: poll returns increasing `rowsProcessed` during `running`
- [ ] Integration: `ready` returns a valid signed URL that actually downloads the file
- [ ] E2E: full export → progress → download

**Tasks**
- [ ] T-3.6.1 `GET /v1/blue-dots/exports/:id` endpoint
- [ ] T-3.6.2 Progress modal
- [ ] T-3.6.3 Download trigger
- [ ] T-3.6.4 Retry flow
- [ ] T-3.6.5 E2E

**Blocked by:** F3.5
