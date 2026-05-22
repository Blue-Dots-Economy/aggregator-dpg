# Telemetry Design — Aggregator DPG

Design reference for distributed tracing, API events, AUDIT events, and structured
logs across the aggregator stack. Goal: one `trace_id` follows a participant
from the moment an aggregator drops a CSV (or a seeker submits a public form)
through to the SignalStack onboard call, with named milestones (API + AUDIT
events) at each business step so dashboards can count "how many onboarded",
"how many failed", "where time was spent".

This doc is the artefact for senior review. Implementation starts only after
the catalogue + event shapes are signed off.

---

## 1. Goals

1. **End-to-end traceability** — given an upload id, link id, or participant id,
   reconstruct the full chain across api + worker + signalstack.
2. **Business signal** — count onboarded participants, failed pushes, link
   submissions, registrations, decisions per aggregator, per time window.
3. **Operator debug** — when a row fails, surface the actual upstream rejection
   text (e.g. `INVALID_ITEM_STATE: must be equal to one of the allowed values`).
4. **No PII** in spans, logs, or events.
5. **Single emit API** for application code — no `if (audit) ... else if (api) ...`.

---

## 2. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            AGGREGATOR DPG                                    │
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                    │
│  │   web        │    │   api        │    │   worker     │                    │
│  │  (Next.js)   │    │  (Fastify)   │    │  (BullMQ)    │                    │
│  │              │    │              │    │              │                    │
│  │  OTel SDK    │◄──►│  OTel SDK    │◄──►│  OTel SDK    │                    │
│  │  + pino      │    │  + pino      │    │  + pino      │                    │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                    │
│         │                   │                   │                            │
│         │  W3C traceparent  │  job payload      │   fetch(traceparent)       │
│         │  header forwarded │  carries trace_id │   to signalstack           │
│         │                                                                    │
│         └───────────┬──────────────────────────────────────────────────────► │
│                     ▼                                                        │
│         ┌──────────────────────┐                                             │
│         │  OTel Collector       │   single config hub:                       │
│         │  (compose service)    │   - PII redact processor                │
│         │                       │   - attribute promotion                    │
│         │                       │     (event.kind, event.name → labels)     │
│         │                       │   - batching, retries                      │
│         │                       │   - tail sampling (phase 1+)               │
│         └──┬──────────┬─────────┘                                            │
│            │          │                                                      │
│            ▼          ▼                                                      │
│         ┌──────┐  ┌──────┐                                                   │
│         │Tempo │  │ Loki │                                                   │
│         │trace │  │ logs │ (incl. API + AUDIT events as log records)         │
│         └──┬───┘  └──┬───┘                                                   │
│            │         │                                                       │
│            └────┬────┘                                                       │
│                 ▼                                                            │
│             Grafana                                                          │
│             - Onboarding funnel        (count of API events per type)        │
│             - Per-aggregator timeline  (filter logs by aggregator_id)        │
│             - Trace explorer           (paste trace_id → flame graph)        │
│             - Error rate               (signalstack_failed / onboarded)      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Same OTel SDK in all three apps. Backend (Tempo / Loki / Grafana — "LGT" stack)
is swappable in collector config without touching app code.

---

## 3. Event catalogue

```
┌──────────────────────────────────────┬───────┬─────┬─────────┬─────────────────────────────┐
│              Event                   │ AUDIT │ API │ Source  │       Trace root            │
├──────────────────────────────────────┼───────┼─────┼─────────┼─────────────────────────────┤
│ aggregator.registered                │   –   │  ✓  │ api     │ yes                         │
│ aggregator.approved                  │   –   │  ✓  │ admin   │ yes                         │
│ aggregator.rejected                  │   –   │  ✓  │ admin   │ yes                         │
│ aggregator.profile_updated           │   ✓   │  –  │ api     │ –                           │
│ bulk_upload.created                  │   –   │  ✓  │ api     │ yes (propagates to worker)  │
│ bulk_upload.file_validating          │   ✓   │  –  │ worker  │ continues                   │
│ bulk_upload.file_failed              │   ✓   │  –  │ worker  │ continues                   │
│ bulk_row.processed                   │   ✓   │  –  │ worker  │ child span                  │
│ bulk_row.failed                      │   ✓   │  –  │ worker  │ child span                  │
│ participant.onboarded_to_signalstack │   –   │  ✓  │ worker  │ child span                  │
│ participant.signalstack_failed       │   –   │  ✓  │ worker  │ child span                  │
│ bulk_upload.completed                │   –   │  ✓  │ worker  │ continues                   │
│ link.created                         │   –   │  ✓  │ api     │ yes                         │
│ link.updated                         │   ✓   │  –  │ api     │ –                           │
│ link.activated                       │   –   │  ✓  │ api     │ yes                         │
│ link.deactivated                     │   –   │  ✓  │ api     │ yes                         │
│ link.submission_received             │   –   │  ✓  │ public  │ yes (propagates to worker)  │
│ link.submission_failed               │   ✓   │  –  │ public  │ –                           │
│ admin.decision_email_sent            │   ✓   │  –  │ admin   │ continues                   │
└──────────────────────────────────────┴───────┴─────┴─────────┴─────────────────────────────┘

Totals: 11 API events, 8 AUDIT events.
```

- **API event** — promoted to the transaction stream (`event.kind=transaction_event`)
  in Loki. Used for dashboards + counts + (future) SSE subscribers.
- **AUDIT event** — span event + structured log only (`event.kind=audit_event`).
  Queryable in Loki by `trace_id`. Not promoted to the transaction stream.

---

## 4. Event envelope (common to API + AUDIT)

All events emit as a single JSON record with three top-level keys: `resource`,
`scope`, `edata`. Discriminator is `resource.eid`. Shape mirrors the
flattened-OTel format already used by adjacent Sanketika services.

```
resource
  eid                  "API" | "AUDIT"            ← discriminator
  producer             "aggregator-api" | "aggregator-worker" | "aggregator-web"
  producerType         "Aggregator"               (facility class, constant)

scope
  name                 "aggregator_api" | "aggregator_worker" | "aggregator_web"
  version              package version
  attributes
    scopeUuid          uuid     stable per process boot
    count              number   sequence within scope (optional)

edata
  name                 string   catalogue value, e.g. "participant.onboarded_to_signalstack"
  status               string   "OK" on success;
                                upstream code on failure (e.g. "INVALID_ITEM_STATE",
                                "UNAUTHORIZED", "FAILED")
  traceId              hex32    W3C trace_id from active OTel context — NOT converted
                                to UUID (keeps `traceparent` propagation joinable)
  spanId               hex16    current span_id
  mid                  ulid     unique per emit (consumer dedupe key)
  ets                  number   epoch ms (emit time)
  observedTimeUnixNano string   nanos since epoch (collector-observed)
  startTimeUnixNano    string   nanos — API events only (span start)
  endTimeUnixNano      string   nanos — API events only (span end)
  severityNumber       number   AUDIT only. OTel severity: 9=DEBUG, 12=INFO,
                                17=WARN, 21=ERROR (pino mixin maps automatically)
  body                 string   AUDIT only. Human-readable summary
  attributes           object   flat KV, dot-namespaced. Always carries:
    aggregator.id        uuid
    actor.kind           "aggregator"|"admin"|"worker"|"public"|"system"
    actor.user_id        KC sub uuid | "worker" | "admin:<domain>" | "public" | "system"
    request.id           string   Fastify req.id or BullMQ job id
    event.version        string   schema version. Bump on payload shape change
    <event-specific>     dot-namespaced KV — see §5
  events
    error              object   present only when status != "OK"
                                { time, attributes: { msg, code, type } }
                                upstream rejection text lives here, NOT in attributes
```

Naming: camelCase for envelope keys (`producerType`, `scopeUuid`, `traceId`).
Dot-namespaced for attribute keys (`aggregator.id`, `upload.id`). Mixing avoids
parser quirks when Loki promotes attribute keys to labels.

### Trace id format

Emit OTel `hex32` / `hex16` strings directly into `traceId` / `spanId`. Adjacent
services in the Sanketika stack accept this form. Do **not** convert to UUID —
the conversion is lossless but breaks distributed correlation when one hop
forgets to convert back.

---

## 5. Per-event payload shapes

All event-specific fields live under `edata.attributes` as dot-namespaced flat
KV. Common envelope fields (§4) are omitted in these listings.

### API events (`resource.eid = "API"`)

```text
aggregator.registered
  org.slug, org.type ('seeker'|'provider'),
  contact.email_domain, registration.status ('pending')

aggregator.approved
  org.slug, decided_by.admin_email_domain,
  status.prev, status.new ('active')

aggregator.rejected
  org.slug, decided_by.admin_email_domain,
  status.prev, status.new ('inactive'), decision.reason

bulk_upload.created
  upload.id, participant.type,
  schema.id, schema.version, file.size_bytes

bulk_upload.completed
  upload.id, count.total, count.passed, count.failed, count.skipped,
  errors.csv_s3_key (null when none), latency_ms

participant.onboarded_to_signalstack
  participant.id, participant.type,
  source ('bulk'|'link'),
  upload.id (optional), link.id (optional),
  signalstack.user_id, signalstack.profile_id,
  latency_ms

participant.signalstack_failed
  participant.id, participant.type,
  source ('bulk'|'link'),
  upload.id (optional), link.id (optional),
  latency_ms
  + edata.events.error = { time, attributes: { msg, code, type } }
                         ← upstream rejection lives here, NOT in attributes

link.created
  link.id, link.domain, link.slug, link.status ('draft'),
  link.expires_at (null when none)

link.activated
  link.id, link.slug, link.public_url

link.deactivated
  link.id, link.slug

link.submission_received
  link.id, link.slug, submission.id, participant.type
```

### AUDIT events (`resource.eid = "AUDIT"`)

Each AUDIT event sets `edata.body` to a fixed human-readable summary (shown
below in quotes) and `edata.severityNumber` to 12 (INFO) unless noted.

```text
aggregator.profile_updated         body="profile fields updated"
  fields.changed (string[])        ← key names only, never raw values

bulk_upload.file_validating        body="csv accepted, validating"
  upload.id, header.columns, declared.rows

bulk_upload.file_failed            body="csv failed validation"   severityNumber=17
  upload.id, error.code, error.reason

bulk_row.processed                 body="row processed"
  upload.id, row.index, row.outcome ('passed'|'skipped'|'failed'),
  row.category, latency_ms

bulk_row.failed                    body="row failed validation"   severityNumber=17
  upload.id, row.index, error.code, error.reason

link.updated                       body="link fields updated"
  link.id, fields.changed (string[])    ← 'slug'|'context'|'expires_at'

link.submission_failed             body="submission rejected"     severityNumber=17
  link.id, link.slug, error.code, error.reason

admin.decision_email_sent          body="decision email dispatched"
  to.email_domain, decision ('approved'|'rejected'),
  template ('aggregator_decision')
```

### PII rules (enforced in `@aggregator-dpg/observability` emitter + pino redact)

Use **partial mask** helpers (matches downstream tooling — operators can still
recognise users for support without raw PII landing in storage):

```ts
maskEmail("matt@test.in")    →  "ma**@test.in"
maskPhone("+918888812345")   →  "+91*******2345"
maskName("Matt Stevens")     →  "M*****"
maskAddress(addr)            →  drop entirely (no value retained)
```

Forbidden in any field unless passed through a mask helper:

```
phone, phoneNumber, hiringManagerPhoneNumber
email, hiringManagerEmail
name, hiringManagerName, contact_name, firstname, lastname
postal address fields (line1, line2, pincode, locality)
item_state values                       ← raw CSV row body. Drop entirely.
```

`actor.user_id` rules:

- aggregator → KC sub (uuid). No masking needed.
- admin → `"admin:<email_domain>"`. Never local part.
- worker / public / system → literal string.

### Concrete example — `participant.signalstack_failed`

```json
{
  "resource": {
    "eid": "API",
    "producer": "aggregator-worker",
    "producerType": "Aggregator"
  },
  "scope": {
    "name": "aggregator_worker",
    "version": "1.0.0",
    "attributes": { "scopeUuid": "0dae9978-51cb-496d-882d-c6d632e52cba", "count": 1 }
  },
  "edata": {
    "name": "participant.signalstack_failed",
    "status": "INVALID_ITEM_STATE",
    "traceId": "fd8c2ceaf34a43df8c9cdea27f338960",
    "spanId": "479c8550fda2_ba8",
    "mid": "01HZQK3W7Y4N6P8B2R5T9V1XCG",
    "ets": 1747393761822,
    "observedTimeUnixNano": "1747393761822000000",
    "startTimeUnixNano": "1747393760692953530",
    "endTimeUnixNano": "1747393761278953530",
    "attributes": {
      "aggregator.id": "39b2ca82-7c1a-4d3e-9f08-1a4d8b2e6c00",
      "actor.kind": "worker",
      "actor.user_id": "worker",
      "request.id": "job-7281",
      "event.version": "1",
      "upload.id": "up_01HZ...",
      "row.index": 42,
      "participant.id": "p_01HZ...",
      "participant.type": "seeker",
      "source": "bulk",
      "latency_ms": 586
    },
    "events": {
      "error": {
        "time": "2025-05-16T11:09:20.692589Z",
        "attributes": {
          "msg": "must be equal to one of the allowed values",
          "code": "INVALID_ITEM_STATE",
          "type": "VALIDATION"
        }
      }
    }
  }
}
```

---

## 6. Distributed tracing — flow with `trace_id`

### One trace per business workflow

```
Workflow                       Trace root                             Spans inside
─────────────────────────────  ─────────────────────────────────────  ─────────────────────
Bulk upload                    api.bulk_upload.create                 worker.bulk_file_process
                                                                      worker.bulk_row.process × N
                                                                      worker.signalstack.onboard
                                                                      worker.bulk_finalise

Public link submission         api.public_link.submit                 worker.link_row.process
                                                                      worker.signalstack.onboard

Aggregator registration        api.aggregator_registration.create     idp.createUser
                                                                      mailer.send

Admin decision (approve/reject) api.aggregator_decision.run           idp.setAttributes
                                                                      mailer.send

Profile update                 api.aggregator_profile.update          idp.setAttributes (when contact)

Link create / activate /       api.link.<action>                      qr.generate, s3.put
deactivate                                                            (activate only)
```

### Propagation

| Hop                        | Mechanism                                                           |
| -------------------------- | ------------------------------------------------------------------- |
| browser → web (Next.js)    | W3C `traceparent` header (auto)                                     |
| web BFF → api              | `traceparent` forwarded by `callApi` helper                         |
| api → worker (BullMQ)      | `propagation.inject(ctx, jobPayload)`; worker `propagation.extract` |
| api / worker → signalstack | fetch auto-instrumentation injects `traceparent`                    |
| api / worker → KC          | fetch auto-instrumentation injects `traceparent`                    |
| api / worker → postgres    | pg auto-instrumentation attaches spans (driver-level)               |

### Span naming

```
api.<resource>.<action>          api.bulk_upload.create
                                 api.link.activate

worker.<job>                     worker.bulk_file_process
worker.<job>.<step>              worker.bulk_row.process

signalstack.<op>                 signalstack.onboard
idp.<op>                         idp.createUser, idp.setAttributes
qr.<op>, s3.<op>, pg.<query>     (mix of manual + auto)
```

### Required span attributes (business spans)

```
aggregator_id, request_id, service.name, deployment.env

Context-specific (when applicable):
  upload_id, link_id, row_index, participant_id, participant_type

On failure:
  error.code, error.message, span.status = ERROR
```

### Example — one bulk upload trace, all signals together

```
TRACE T1 = "9c0c8a4d2b…"   aggregator_id = 39b2ca82…

  span: api.bulk_upload.create               [upload_id, participant_type]
   ├─ ⚡ API event: bulk_upload.created
   ├─ span: pg.insert bulk_uploads             (auto)
   └─ log.info  operation=api.bulk_upload.create  status=success  latency_ms=43

  span: queue.enqueue bulk-file-process        [propagates T1 into job payload]

  span: worker.bulk_file_process              [upload_id]
   ├─ span: s3.get_object
   ├─ ◆ AUDIT event: bulk_upload.file_validating
   └─ on failure: ◆ AUDIT event: bulk_upload.file_failed

  span: worker.bulk_row.process               [upload_id, row_index, …]   × N rows
   ├─ span: ajv.validate
   ├─ if invalid: ◆ AUDIT event: bulk_row.failed
   ├─ ◆ AUDIT event: bulk_row.processed
   └─ span: worker.signalstack.onboard
        ├─ span: fetch POST .../onboard        (auto, attrs: http.status, signalstack.user_id)
        └─ success → ⚡ API event: participant.onboarded_to_signalstack
                                   edata.status = "OK"
           fail    → span.status=ERROR
                     ⚡ API event: participant.signalstack_failed
                                   edata.status         = upstream code
                                   edata.events.error   = { time, attributes:
                                                            { msg, code, type } }
                     log.error  operation=worker.signalstack.onboard  severityNumber=21

  span: worker.bulk_finalise                  [upload_id]
   ├─ span: s3.put_object errors.csv
   ├─ span: pg.update bulk_uploads status=completed
   └─ ⚡ API event: bulk_upload.completed
            edata.attributes: { count.total, count.passed, count.failed,
                                count.skipped, errors.csv_s3_key, latency_ms }

Glyphs:
  span:  = OTel span (Tempo)
  ⚡     = API event (transaction stream → Loki, also recorded as span event)
  ◆     = AUDIT event (span event + structured log → Loki)
  log    = pino info/warn/error auto-tagged with trace_id
```

---

## 7. Metrics derivable from API + AUDIT events

Loki queries return counts directly; no separate metric pipeline needed in
phase 0. Collector's `attributes` processor promotes these `edata` fields to
Loki labels (underscored — Loki labels can't carry dots): `edata.name` →
`event_name`, `edata.attributes.aggregator.id` → `aggregator_id`, etc.

```
PromQL-style sketches (over Loki log streams):

# How many onboarded today
count_over_time({event_name="participant.onboarded_to_signalstack"}[1d])

# Per aggregator over last 7 days
sum by (aggregator_id) (
  count_over_time({event_name="participant.onboarded_to_signalstack"}[7d])
)

# Signalstack error rate
sum(rate({event_name="participant.signalstack_failed"}[5m]))
 /
sum(rate({event_name=~"participant.onboarded_to_signalstack|participant.signalstack_failed"}[5m]))

# Bulk uploads completed today
count_over_time({event_name="bulk_upload.completed"}[1d])

# Rows failing per aggregator in last hour
sum by (aggregator_id) (
  count_over_time({event_name="bulk_row.failed"}[1h])
)

# Link submissions per link
sum by (link_id) (
  count_over_time({event_name="link.submission_received"}[24h])
)

# Pending aggregator registrations (no follow-up decision)
count_over_time({event_name="aggregator.registered"}[7d])
 -
count_over_time({event_name=~"aggregator.approved|aggregator.rejected"}[7d])
```

If/when count traffic grows, the OTel collector can derive Prometheus metrics
from the same event stream (`spanmetrics` or `logsdataset` connectors).

---

## 8. Logs

Pino remains the structured logger. Two upgrades:

### Auto-correlation

`traceId`, `spanId`, `aggregator.id`, `request.id`, `service`, `env` are
auto-injected on every log line via a pino mixin reading the active OTel
context. App code keeps the existing shape:

```ts
logger.info({
  operation: 'worker.signalstack.onboard',
  status: 'OK',
  latency_ms: 412,
});
```

### Severity ladder — pino → OTel `severityNumber`

| pino level | pino numeric | OTel severityNumber | Use for                                       |
| ---------- | ------------ | ------------------- | --------------------------------------------- |
| debug      | 20           | 5                   | internal step trace, dev-only                 |
| info       | 30           | 9                   | normal milestone (default for AUDIT/API emit) |
| warn       | 40           | 17                  | recoverable anomaly (retry, dedup-skip)       |
| error      | 50           | 21                  | failure path; emit with `error_type + cause`  |

The pino mixin maps pino numeric → OTel `severityNumber` before the OTLP log
exporter ships the record. App code never sets `severityNumber` directly.

### Pipeline

```
app process
  → @aggregator-dpg/observability (pino + OTLP log transport)
  → OTLP gRPC :4317 (in-process, no stdout scrape)
  → OTel collector
    - PII redact processor (defense in depth)
    - attribute promotion (eid, name → Loki labels)
    - batching, retries
  → exporter: Loki
```

Note: in-process OTLP log shipping (via `pino-opentelemetry-transport` or
equivalent) preserves trace context. Avoid the older stdout → filelog scrape
path — collector JSON-parse delays decouple log timestamps from spans.

### PII redaction

Single pino `redact` config in `@aggregator-dpg/observability`, identical paths
as the event envelope's forbidden list. One place to change.

---

## 9. Stack

| Layer              | Phase 0 (local + staging)                                             |
| ------------------ | --------------------------------------------------------------------- |
| Instrumentation    | OpenTelemetry SDK (`@opentelemetry/sdk-node`) + auto-instrumentations |
| Logger             | pino (existing) with OTel context mixin                               |
| Transport          | OTLP gRPC :4317                                                       |
| Collector          | `otel/opentelemetry-collector-contrib` as a docker compose service    |
| Traces             | Tempo (compose)                                                       |
| Logs + events      | Loki (compose)                                                        |
| Dashboards         | Grafana (compose), datasources pre-wired                              |
| Metrics (optional) | Prometheus / Mimir (deferrable — Loki count_over_time covers phase 0) |

Phase 1+ swap targets without touching app code by changing the collector's
exporter config (e.g. Grafana Cloud, Datadog, Honeycomb, AWS X-Ray + CloudWatch).

## 10. Glossary

| Term              | Definition                                                                           |
| ----------------- | ------------------------------------------------------------------------------------ |
| Trace             | A directed tree of spans sharing one `trace_id`, spanning processes.                 |
| Span              | A timed operation. May have child spans + point-in-time span events.                 |
| Span event        | A named marker at a point in time on a span (e.g. `bulk_row.processed`).             |
| Transaction event | API event in our taxonomy. OTel log record with `event.kind=transaction_event`.      |
| AUDIT event       | OTel log record with `event.kind=audit_event`. Span event + log only — not promoted. |
| Trace context     | The propagated identity of a trace, carried via W3C `traceparent`.                   |
| LGTM stack        | Loki + Grafana + Tempo + Mimir — Grafana Labs OSS observability suite.               |
| OTLP              | OpenTelemetry Protocol. Wire format for traces/logs/metrics over gRPC or HTTP.       |
| Tail sampling     | Decide whether to keep a trace AFTER all spans land (e.g. always keep errors).       |
