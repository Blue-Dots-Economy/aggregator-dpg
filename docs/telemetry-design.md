# Telemetry Design — Aggregator-DPG

---

Async-only OpenTelemetry observability. Three first-class signals — **traces, metrics, logs** — plus a fourth post-hoc **outcome event** stream. A shared `@aggregator-dpg/telemetry` library boots OTel SDKs at process start; every block self-instruments via hot-path APIs that never block on I/O. Post-turn analytics fire to a standalone Observability service over an async transport. **Zero impact on response latency. Single `trace_id` stitches every block end-to-end. Outcome metrics are config-driven — no business logic hardcoded.**

---

## 1. Goals

| #   | Goal                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------- |
| G1  | One `trace_id` follows a participant from CSV drop / public form submit → API → BullMQ job → Signals Stack call → audit record. |
| G2  | Observability adds **< 1 ms p99** to the response path.                                                                         |
| G3  | Metrics, traces, logs all queryable from Grafana with `trace_id` deep-linking (Tempo↔Loki↔Prometheus exemplars).                |
| G4  | DPDP-compliant: no PII in metric labels, structured allow-list in logs, audit-grade retention for personal data.                |
| G5  | Pluggable backend: swap Jaeger↔Tempo or Prometheus↔Mimir without app changes (OTel decouples).                                  |
| G6  | Outcome / lifecycle metrics expressed declaratively in YAML — no code change to add a new business KPI.                         |
| G7  | Same instrumentation pattern works for `api` (Fastify), `worker` (BullMQ), `web` (Next.js BFF), and future services.            |

## 2. Glossary

| Term                          | Meaning                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Block**                     | Any deployable unit emitting telemetry (currently: `api`, `worker`, `web` BFF).                                        |
| **Hot path**                  | Request-handling code that contributes to user-visible latency.                                                        |
| **Outcome / lifecycle event** | A post-hoc business signal (`participant_registered`, `bulk_upload_completed`). Fired async, not in the response path. |
| **OTLP**                      | OpenTelemetry Protocol; gRPC on `:4317`, HTTP on `:4318`.                                                              |
| **Exemplar**                  | A `trace_id` attached to a Prometheus histogram bucket, enabling click-through Grafana → Tempo.                        |
| **Tail sampling**             | Sampling decision made *after* a trace finishes, so errors / slow traces are always kept.                              |

---

## 3. Architecture (4 tiers)

Four tiers: **Edge → Aggregator → Collection → Backend**. One `trace_id` flows
end-to-end. All apps emit via shared `@aggregator-dpg/observability` package
over OTLP gRPC. Collector fans signals into Jaeger / Loki / Prometheus.

**Legend:** 🟦 span · 📊 metric · 📝 log · ⚡ API event · ◆ AUDIT event

```
+--------------------------------------------------------------------+
|  TIER 1 — EDGE                                                     |
|  Browser | Admin | CSV upload | Webhook | Mobile SDK               |
+--------------------------------------------------------------------+
              | HTTPS + W3C traceparent + baggage(aggregator.id)
              v
+--------------------------------------------------------------------+
|  TIER 2 — AGGREGATOR DPG                                           |
|                                                                    |
|  Shared bootstrap: @aggregator-dpg/observability                   |
|   - TracerProvider  (W3C TraceContext + Baggage)                   |
|   - MeterProvider   (5s OTLP flush)                                |
|   - LoggerProvider  (stdlib/winston -> OTLP)                       |
|   - emitTransaction()  =>  API event   (event.kind=transaction)    |
|   - emitAudit()        =>  AUDIT event (event.kind=audit)          |
|                                                                    |
|   +----------+        +----------+        +-------------+          |
|   |   web    |  HTTP  |   api    | BullMQ |   worker    |          |
|   | Next.js  |------->| Fastify  |------->|  processor  |          |
|   |  :3000   |        |  :8080   |  jobs  |             |          |
|   +----------+        +----------+        +-------------+          |
|   web.render          api.request         worker.bulk_file_process |
|   web.api_proxy       api.bulk_upload.*   worker.bulk_row.process  |
|                       pg.insert           worker.signalstack.onboard
|                       queue.enqueue                                |
|                                                                    |
|   Events emitted:                                                  |
|     api    : bulk_upload.created, link.created, aggregator.*       |
|     worker : bulk_row.processed (audit), participant.onboarded,    |
|              participant.signalstack_failed, bulk_upload.completed |
|                                                                    |
|   State tier (auto-instrumented child spans):                      |
|     Postgres | Redis | BullMQ Queue | S3                           |
|                                                                    |
|   Outbound -> SignalStack /onboard  (traceparent forwarded)        |
+--------------------------------------------------------------------+
              | OTLP gRPC :4317  (traces + metrics + logs + events)
              v
+--------------------------------------------------------------------+
|  TIER 3 — COLLECTION  (OTel Collector)                             |
|                                                                    |
|  receivers : otlp { grpc :4317, http :4318 }                       |
|  processors: memory_limiter -> redact -> promote -> batch          |
|                -> tail_sampling (phase 1+)                         |
|  pipelines :                                                       |
|    traces   -> [redact, batch]           -> otlp/jaeger            |
|    metrics  -> [batch]                   -> prometheus             |
|    logs     -> [redact, promote, batch]  -> loki                   |
+--------------------------------------------------------------------+
              |               |                |
        traces|        logs+⚡+◆|         metrics|
              v               v                v
+--------------------------------------------------------------------+
|  TIER 4 — BACKEND  (swappable)                                     |
|                                                                    |
|   +-----------+      +-----------+      +-----------+              |
|   |  Jaeger   |      |   Loki    |      |Prometheus |              |
|   | OTLP:4317 |      | push:3100 |      | TSDB:9090 |              |
|   | UI :16686 |      |           |      | exemplars |              |
|   +-----------+      +-----------+      +-----------+              |
|         \                |                 /                       |
|          \               |                /                        |
|           v              v               v                         |
|                       +---------+                                  |
|                       | Grafana | dashboards + Alertmanager        |
|                       +---------+                                  |
+--------------------------------------------------------------------+
```

### Why this shape

- **Same SDK in every block.** Bootstrap from one shared package. Apps never
  talk to backends directly.
- **Pino producer, OTel `LoggerProvider` wire layer.** Pino stays as the
  application logging API (per `logging-observability.md`); a custom pino
  transport hands records to the OTel `LoggerProvider`, which exports OTLP-logs.
  `trace_id` + `span_id` are auto-injected from the active span. One wire
  format. No file scraper. See §4.3.
- **Backend tier is swappable.** Change Collector `exporters:` — apps unchanged.
- **Collector is the only PII gate.** Redaction lives in one config, not in app
  code. Apps emit raw structured records.
- **One `trace_id`, three blocks, four hops.** Edge -> web -> api -> worker ->
  SignalStack. W3C TraceContext on HTTP boundaries; injected into BullMQ job
  payload across the queue boundary.

### Service block catalogue (summary; full spans + metrics in §5, §6)

| Block  | Stack       | Key spans                                                | Key metrics                                                  |
| ------ | ----------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| web    | Next.js SSR | `web.render`, `web.api_proxy`                            | `web.ttfb_ms`, `web.requests`                                |
| api    | Fastify     | `api.request`, `api.bulk_upload.create`, `queue.enqueue` | `api.requests`, `api.latency_ms`, `api.5xx`                  |
| worker | BullMQ      | `worker.bulk_row.process`, `worker.signalstack.onboard`  | `signalstack.calls_total`, `bulk.rows_total`, `*.duration_ms`|

### Resource attributes per block

```js
build_resource({
  service_name:           "aggregator-api",     // or aggregator-web, aggregator-worker
  service_namespace:      "aggregator",
  service_version:        process.env.APP_VERSION,
  service_instance_id:    process.env.HOSTNAME ?? randomUUID(),  // pod/replica disambiguation
  "dpg.block":            "api",                // web | api | worker
  deployment_environment: process.env.ENV,      // dev | staging | prod
})
```

`service.instance.id` is required — without it, multi-replica deploys collapse
into a single series and fan-out queries (per-pod latency, per-pod queue depth)
break silently. Use the Kubernetes `HOSTNAME` env when present; fall back to a
process-lifetime UUID.

Loki labels (bounded): `{service_name, dpg_block, deployment_environment, event_kind, event_name}`.
High-cardinality fields (`trace_id`, `aggregator_id`, `upload_id`) stay in the log body, queried via `| json | aggregator_id="…"`.

## 4. Signal Model

### 4.1 Traces

| Aspect              | Convention                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Span name           | `<package>.<operation>` (e.g. `signal-stack-client.fetchMembers`, `worker.bulk-upload.process-row`)        |
| Required attributes | `service.name`, `service.version`, `deployment.environment`, `aggregator_id` (Baggage), `participant_kind` |
| Status              | `ok` on success, `error` on caught exception (call `recordException`)                                      |
| Events              | `retry`, `circuit_open`, `cache_hit`, `validation_failed`                                                  |
| Links               | Use `links` when one trace fans out to multiple jobs (BullMQ batch)                                        |

### 4.2 Metrics

| Instrument        | Use for                | Example                                     |
| ----------------- | ---------------------- | ------------------------------------------- |
| `Counter`         | Monotonic counts       | `api.requests.total{route, method, status}` |
| `UpDownCounter`   | Gauges that go up/down | `worker.queue.depth{queue}`                 |
| `Histogram`       | Latency, sizes         | `api.request.duration_ms{route, method}`    |
| `ObservableGauge` | Pull-style state       | `db.pool.in_use_connections`                |

Naming: `<domain>.<object>.<unit_or_action>` — dot-delimited. Unit suffix (`_ms`, `_bytes`) where applicable.

**Histogram bucket boundaries** (do NOT rely on OTel defaults — they are
exponential 0–10s and yield useless p99s for our workloads):

| Histogram family               | Bucket boundaries (ms)                                       |
| ------------------------------ | ------------------------------------------------------------ |
| HTTP / API request latency     | `5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000`      |
| DB / Redis call latency        | `1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000`                |
| Upstream (SignalStack) latency | `10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000`      |
| BullMQ job duration            | `100, 500, 1000, 5000, 15000, 60000, 300000, 900000`         |
| Bulk-row processing            | `10, 50, 100, 500, 1000, 5000, 30000`                        |

Buckets are declared once in `@aggregator-dpg/telemetry` via `Views`; hot-path
code does not specify them.

### 4.3 Logs

Pino remains the in-process logging API (per `.claude/rules/logging-observability.md`).
A custom pino transport ships records to the OTel `LoggerProvider`, which exports
to the Collector over OTLP. `trace_id` / `span_id` are injected by the transport
from the active span context — application code never sets them.

This supersedes the §3 phrasing "OTel LoggerProvider, not pino": pino is the
producer, OTel LoggerProvider is the wire layer. There is no file scraper.

Required log fields (from existing rule `logging-observability.md`, unchanged):

| Field                 | Notes                               |
| --------------------- | ----------------------------------- |
| `operation`           | `package.method` form               |
| `status`              | `success` \| `failure` \| `skipped` |
| `error`, `error_type` | failure only                        |
| `latency_ms`          | external calls                      |
| `trace_id`, `span_id` | injected by transport               |
| `aggregator_id`       | when in request context             |

### 4.4 Outcome events

Discrete business events posted async to `observability-svc`. Examples: `participant.registered`, `bulk_upload.completed`, `registration_link.expired`. Each event becomes one or more metric increments inside the Observability service — never directly in the originating service.

---

## 5. Trace Propagation

### 5.1 HTTP (browser → web BFF → api)

- **Browser:** v1 ships **without** a browser OTel SDK — the Tier 1 box in §3
  showing `traceparent` from the browser is aspirational. v1 root spans start
  at the **web BFF** (Next.js server). A future v2 may add `@opentelemetry/sdk-trace-web`
  + fetch instrumentation; until then, RUM is out of scope.
- **Inbound at web BFF / api:** Fastify and Next.js server auto-instrumentation
  read `traceparent` / `tracestate`. If absent (the v1 default for user-initiated
  navigations), a new root span starts at the BFF.
- **`x-request-id`:** retained as a Baggage entry (`x-request-id`) so logs and the existing reqId log label still correlate. No regression on today's behaviour.
- **Outbound:** the HTTP client (undici / fetch) auto-injects `traceparent` on every call to the API and Signals Stack.

### 5.2 BullMQ (api → redis → worker)

BullMQ has no native OTel hook. The shared lib wraps `queue.add`:

```ts
import { context, propagation, trace } from '@opentelemetry/api';

export function addJobWithTrace<T>(queue: Queue<T>, name: string, data: T) {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return queue.add(name, { ...data, _otel: carrier });
}
```

Worker side:

```ts
new Worker(name, async job => {
  const parent = propagation.extract(context.active(), job.data._otel ?? {});
  return await context.with(parent, () =>
    tracer.startActiveSpan(`worker.${name}.process`, async span => {
      try { return await handler(job); }
      finally { span.end(); }
    }),
  );
});
```

### 5.3 Async outcome emit

The outgoing POST carries `traceparent` so the Observability service span links back to the originating trace.

---

## 6. Cardinality + PII + DPDP

### 6.1 Cardinality matrix

| Attribute                                      | Type               | Allowed on metric labels?                                     | On span / log? |
| ---------------------------------------------- | ------------------ | ------------------------------------------------------------- | -------------- |
| `intent`, `state`, `status`, `route`, `method` | bounded enum       | yes                                                           | yes            |
| `aggregator_id`                                | ID (≤ 10k)         | **conditional** — only on coarse rollups, never on histograms | yes            |
| `session_id`, `turn_id`, `trace_id`            | unbounded          | **no**                                                        | yes            |
| `user_id`                                      | DPDP personal data | **never** in metrics                                          | audit log only |
| `phone`, `email`, `name`, `address`            | DPDP personal data | **never**                                                     | audit log only |
| Bulk upload `row_index`                        | unbounded          | **no**                                                        | span only      |

Hard cap: each metric must have **≤ 100 unique label combinations** in steady state. Reviewer must enforce in PR.

**Attribute value size limits** (configured via `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`):

| Signal              | Per-attribute limit | Per-span/event total |
| ------------------- | ------------------- | -------------------- |
| Span attributes     | 4 KiB               | 32 KiB               |
| Span events         | 8 KiB               | 64 KiB (10 events)   |
| Log body            | 16 KiB              | n/a                  |
| Metric labels       | 256 bytes           | n/a (cardinality cap is the real lever) |

Long-form payloads (bulk-upload row CSV, error stack traces, request bodies)
must be **truncated at the producer**, not the Collector — set `truncated=true`
on the span and reference an S3 object key if the full payload is needed for
audit. Never attach a >4 KiB string to a span attribute.

### 6.2 PII allow-list

Source of truth: `config.observability.audit.pii_fields_excluded`. Two separate lists:

- `audit.pii_fields_excluded` — strict; applied to the audit log path.
- `telemetry.pii_fields_excluded` — looser; applied to general traces/logs.

Pino redaction continues to apply on top — defence in depth.

### 6.3 DPDP retention

| Stream                               | Retention                              |
| ------------------------------------ | -------------------------------------- |
| Metrics (Prometheus raw)             | 30 days                                |
| Metrics (Mimir downsampled, no PII)  | 1 year                                 |
| Traces                               | 7 days                                 |
| Application logs (Loki)              | 30 days                                |
| Audit log (PII permitted, S3 sealed) | per `audit.retention_days`, default 90 |

**Audit log write path.** The OTel pipeline is **not** the audit log. Audit
records (`event.kind=audit`) are emitted via `emitAudit()` in
`@aggregator-dpg/telemetry` which:

1. Validates against the audit schema (Zod) — drop on parse failure with a
   `telemetry.audit.dropped_total{reason}` counter increment.
2. Signs each record (HMAC-SHA256, key from KMS) and writes to a dedicated
   BullMQ queue (`audit-write`).
3. The audit worker batches every 5 s and writes to S3 with object lock
   (compliance mode) under `s3://<bucket>/audit/<env>/<yyyy>/<mm>/<dd>/`.
4. S3 bucket has `audit.retention_days` lifecycle policy and bucket-level
   default encryption (SSE-KMS). Object lock prevents deletion before retention.

The audit path **never** goes through the Collector — keeping it out of OTel
means a Collector outage cannot drop compliance records, and the Collector
operator never sees raw PII.

### 6.4 Cost / volume budget

Top-line budgets per environment (steady state at 100 RPS, v1):

| Signal  | Budget                       | Enforcement                                 |
| ------- | ---------------------------- | ------------------------------------------- |
| Traces  | ≤ 50 GB/day                  | Tail sampling + head ratio; alert at 80%    |
| Metrics | ≤ 500k active series         | Cardinality cap per metric (§6.1)           |
| Logs    | ≤ 100 GB/day                 | Log level discipline; alert at 80%          |
| Audit   | ≤ 10 GB/day (S3 sealed)      | Schema validation; one record per business event |

A Prometheus rule `telemetry.budget.usage_ratio{signal}` exposes current vs.
budget. Breaching 100% does not block writes (we don't want telemetry to cause
incidents) — it pages the platform team.

---

## 7. Sampling Strategy

| Stage                         | Strategy                                                                              | Rationale                              |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| **Head sampling (SDK)**       | `ParentBased(TraceIdRatioBased(env_specific))` — dev `1.0`, staging `0.5`, prod `0.1` | Cheap, fast, but loses errors if blind |
| **Tail sampling (Collector)** | Always keep: errors, `latency_ms > 2000`, sampled requests w/ a flagged route         | Catches what head sampling drops       |
| **Metrics**                   | Always 100 % — sampling never applies to metrics                                      | Aggregates must be accurate            |
| **Logs**                      | Never sampled                                                                         | Log loss = blind spot                  |

**Tail sampling sizing and degradation:**

- v1: sized for ≤ 100 RPS, ~10 s decision window, ~512 MiB Collector memory.
- Collector runs with `memory_limiter` set to soft=400 MiB, hard=512 MiB.
- **Above the hard limit:** the Collector falls back to **head-only sampling**
  for new traces (the tail processor drops new entries rather than buffering)
  and emits `otelcol_processor_tail_sampling_dropped_total`. This is the
  intended degraded mode — known-error traces still arrive via head sampling
  with `error=true`, just without the "always keep slow" guarantee.
- A platform alert fires on `dropped > 0` sustained for 5 m.
- v2 (>500 RPS): move tail sampling to a dedicated Collector replica set with
  load-balancing exporter on the gateway (so all spans of a trace land on the
  same backend instance).


## 8. Folder Layout

### 8.1 Shared library — `packages/telemetry`

```
packages/telemetry/
├── src/
│   ├── interface.ts            # abstract TelemetryBase, Result types
│   ├── bootstrap.ts            # bootTelemetry({ service, version, config })
│   ├── resource.ts             # buildResource() — service.* + deployment.*
│   ├── propagator.ts           # W3C TraceContext + Baggage wiring
│   ├── pino-otel-transport.ts  # bridge for existing pino loggers
│   ├── bullmq.ts               # addJobWithTrace, wrapWorker
│   ├── http.ts                 # fastify + undici auto-instrumentation
│   ├── outcomes.ts             # client for POST /emit/turn|signal
│   ├── testing/
│   │   ├── index.ts            # TelemetryFake (in-memory)
│   │   └── build.ts            # buildSpanFixture()
│   └── index.ts
├── package.json
└── README.md
```

Follows existing `.claude/rules/base-class-pattern.md`, `interfaces.md`, and `testing.md`.

### 8.2 Per-service surface

```
apps/<svc>/src/
├── telemetry.ts                # imports bootTelemetry + instruments
└── app.ts                      # await bootTelemetry() before listen()
```

### 8.3 Standalone outcome service — `apps/observability-svc/` (new)

```
apps/observability-svc/
├── src/
│   ├── server.ts               # Fastify, POST /emit/{turn,signal}, GET /health
│   ├── outcome-tracker.ts      # lifecycle FSM
│   ├── config.ts               # zod-validated observability config
│   └── exporters.ts            # OTel meter wiring
└── package.json
```

---

## 9. Configuration

Lives under `config/observability/` and loaded by `@aggregator-dpg/config-loader`.

```yaml
observability:
  otel:
    collector_endpoint: "http://otel-collector:4317"
    protocol: grpc           # grpc | http
    sample_rate: 0.1         # head sample; overridden per env
    export_interval_ms: 5000
    timeout_ms: 10000

  outcomes:
    lifecycle:
      - state: "participant_registered"
        trigger_event: "participant.created"
      - state: "bulk_upload_completed"
        trigger_event: "bulk_upload.finalised"
    metrics:
      - name: "participant.registered.total"
        instrument: counter
        description: "Count of participants successfully registered"
        unit: "1"
        attributes: ["aggregator_id_bucket", "participant_kind", "source"]
      - name: "bulk_upload.row.duration_ms"
        instrument: histogram
        description: "Per-row processing latency in worker"
        unit: "ms"
        attributes: ["status"]

  sli:
    api_p99_ms: 800
    api_error_rate_max: 0.005
    worker_success_rate_min: 0.95

  # SLOs drive Prometheus alert rules (provisioned via infra repo, not here).
  # Each SLI becomes a multi-window burn-rate alert pair: page on fast burn
  # (2% budget in 1h) and ticket on slow burn (5% in 6h). Error budget = 1 - SLO.
  # On exhaustion (budget < 0): the platform freeze policy blocks non-critical
  # PRs in the affected service until budget recovers — same gate as the
  # mobile-release freeze (see ops runbook).
  slo:
    api_availability_target: 0.995          # 1 - api_error_rate_max
    api_latency_target_p99_ms: 800          # mirrors sli.api_p99_ms
    worker_success_target: 0.95
    alert_routes:
      page:   pagerduty/aggregator-oncall
      ticket: linear/INGEST

  audit:
    retention_days: 90
    pii_fields_excluded: [user_message, user_id, phone, email, name, address]

  telemetry:
    pii_fields_excluded: [user_message, phone, email]
```

Per-environment overrides: `config/env/{dev,staging,prod}.yaml`.

---

## 10. SDK Lifecycle, Failure Modes, Rollout

### 10.1 Graceful shutdown

Every block calls `sdk.shutdown()` on `SIGTERM` / `SIGINT` before the process
exits. Without this, the last `BatchSpanProcessor` flush is lost on every
deploy — practically guaranteeing missing data exactly when you want it most
(rolling restarts, crashes, scale-down).

```ts
// packages/telemetry/src/bootstrap.ts
let sdk: NodeSDK;
export async function bootTelemetry(opts) { sdk = new NodeSDK({ /* … */ }); await sdk.start(); }
export async function shutdownTelemetry() { await sdk.shutdown(); }

// apps/<svc>/src/server.ts
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    await app.close();              // stop accepting new work
    await shutdownTelemetry();      // flush exporters
    process.exit(0);
  });
}
```

BullMQ workers additionally drain the active job before calling
`shutdownTelemetry()`. Kubernetes `terminationGracePeriodSeconds` must be ≥
`OTEL_BSP_SCHEDULE_DELAY` + `OTEL_BSP_EXPORT_TIMEOUT` + worker drain budget
(default: 30 s).

### 10.2 Kill switch

`OTEL_SDK_DISABLED=true` skips `bootTelemetry()` entirely — pino still logs to
stdout, but no OTel SDK is constructed and no OTLP traffic is generated. This
is the production escape hatch when OTel itself causes an incident (Collector
loop, SDK memory leak, exporter regression). Document it in the on-call
runbook. Roll back via `kubectl set env` without a rebuild.

### 10.3 Collector backpressure

In-process protection (each app):

| Setting                          | Value           | Rationale                                    |
| -------------------------------- | --------------- | -------------------------------------------- |
| `OTEL_BSP_MAX_QUEUE_SIZE`        | 2048 spans      | Bounded in-memory buffer                     |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | 512 spans       | Per OTLP request                             |
| `OTEL_BSP_SCHEDULE_DELAY`        | 5000 ms         | Flush cadence                                |
| `OTEL_BSP_EXPORT_TIMEOUT`        | 30000 ms        | Hard cap on a single export                  |
| `OTEL_METRIC_EXPORT_INTERVAL`    | 5000 ms         | Matches §9 `export_interval_ms`              |

When the BSP queue fills, **new spans are dropped** (counted via
`otel.dropped_spans_total`). This is the correct behavior — applying
backpressure to the hot path would violate G2 (< 1 ms p99 impact).

If the Collector is unreachable for > 5 m, the in-process queue saturates and
drops start. An alert fires on `otel.dropped_spans_total > 0`. Apps stay
healthy; only telemetry is degraded.

### 10.4 Phased rollout

| Phase | Scope                                                | Gate to next phase                                |
| ----- | ---------------------------------------------------- | ------------------------------------------------- |
| 0     | `@aggregator-dpg/telemetry` package + tests + boot stub | Package ships; bootTelemetry is a no-op behind a flag |
| 1     | `api` instrumented in dev only                       | No p99 regression on `api.request.duration_ms`; trace stitching verified end-to-end in dev |
| 2     | `api` + `worker` in staging, head sample 1.0         | One week of clean SLO; tail sampling validated    |
| 3     | All three blocks in prod, head sample 0.1, tail on   | Two weeks clean; cost ≤ 80% of §6.4 budget        |
| 4     | `apps/observability-svc` deployed; outcome events on | Dedup verified; auth enforced; see §12            |
| 5     | Decommission any legacy log scraping / metric paths  | —                                                 |

Each phase is gated by an explicit go/no-go review against G1–G7. Rollback at
any phase is `OTEL_SDK_DISABLED=true` on the affected service.

---

## 11. Code Patterns

All TypeScript. Same structure works for Python services (just swap to `opentelemetry-api` / `opentelemetry-sdk`).

### 11.1 Boot

```ts
// apps/api/src/server.ts
import { bootTelemetry } from '@aggregator-dpg/telemetry';
import { config } from './config.js';

await bootTelemetry({
  serviceName: 'aggregator-api',
  serviceVersion: process.env.GIT_SHA ?? 'dev',
  config: config.observability,
});
// — only after boot completes —
const app = Fastify({ /* … */ });
```

### 11.2 Hot path

```ts
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('signal-stack-client');
const meter  = metrics.getMeter('signal-stack-client');
const calls    = meter.createCounter('signal_stack.calls.total');
const latency  = meter.createHistogram('signal_stack.duration_ms', { unit: 'ms' });

export async function fetchMembers(aggregatorId: AggregatorId): Promise<Result<Member[], BaseError>> {
  return tracer.startActiveSpan('signal-stack-client.fetchMembers', async span => {
    span.setAttribute('aggregator_id', aggregatorId);
    const start = Date.now();
    try {
      const res = await httpClient.get(`/members?aggregator=${aggregatorId}`);
      calls.add(1, { status: 'success' });
      return ok(res.body);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      calls.add(1, { status: 'failure' });
      return err(new UpstreamError('signal stack failed', { cause: e }));
    } finally {
      latency.record(Date.now() - start);
      span.end();
    }
  });
}
```

### 11.3 Outcome emit (fire-and-forget)

```ts
import { emitTurn } from '@aggregator-dpg/telemetry/outcomes';
import { randomUUID } from 'node:crypto';

// inside a request handler, AFTER reply.send():
queueMicrotask(() => {
  emitTurn({
    event: 'participant.created',
    idempotency_key: `participant.created:${participantId}`,  // see §12.2
    attributes: { aggregator_id, participant_kind, source: 'csv' },
  }).catch((e) => {
    // never raise — but always count, or you'll be blind to telemetry loss
    droppedOutcomes.add(1, { event: 'participant.created', reason: e?.code ?? 'unknown' });
  });
});
```

The `idempotency_key` must be derivable from the business event (entity ID +
event name), **not** randomly generated — see §12.2.

---

## 12. Async Event Endpoint (Observability service)

### 12.1 Endpoints

| Method | Path               | Auth        | Body                                                                                    | Behaviour                                                                       |
| ------ | ------------------ | ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/emit/turn`       | mTLS or HMAC | Full turn payload — `event`, `idempotency_key`, `attributes`, optional `tool_calls`, `latencies`, `tokens` | Always 200 on accept or duplicate. Validates Zod schema, drops on parse failure with metric increment. |
| POST   | `/emit/signal`     | mTLS or HMAC | Discrete signal — `name`, `idempotency_key`, `attributes`                              | Always 200 on accept or duplicate.                                              |
| GET    | `/validate-config` | admin token | —                                                                                       | Returns loaded `observability:` config + parse warnings. **Not public.**        |
| GET    | `/health`          | none        | —                                                                                       | Liveness only — no config leak.                                                 |
| GET    | `/ready`           | none        | —                                                                                       | Readiness — verifies OTLP exporter handshake.                                   |

### 12.2 Auth model

`observability-svc` runs inside the cluster but is **not** unauthenticated.
Two accepted credentials:

- **mTLS** (preferred, cluster-internal) — peer cert SAN must match
  `aggregator-{api,web,worker}.<namespace>.svc`. NetworkPolicy restricts
  ingress to those service accounts.
- **HMAC-SHA256 over body** with a shared secret per caller, key ID in
  `X-Outcome-Key-Id` header, signature in `X-Outcome-Signature`. Used for any
  caller outside the cluster mesh (e.g. cron jobs). Replay window: 5 m
  (timestamp in header, rejected outside the window).

`/validate-config` requires a separate static admin token (env var on the
service); returning loaded config to anonymous callers leaks PII allow-lists
and endpoint URLs and is not acceptable.

### 12.3 Outcome event dedup

At-least-once delivery is the producer contract (BullMQ retries, fire-and-forget
in handlers). Without dedup, every job retry double-counts business KPIs.

- Every outcome event carries a caller-supplied `idempotency_key` derived from
  the business event: `<event_name>:<entity_id>[:<phase>]`. Examples:
  `participant.created:p-abc123`, `bulk_upload.completed:upload-9f`,
  `bulk_row.processed:upload-9f:row-42`.
- `observability-svc` stores seen keys in Redis under
  `obs:idem:<key>` with TTL = `audit.retention_days` × 24h (default 90 d × 24h).
- On duplicate: return 200 immediately, increment
  `observability.outcome.duplicate_total{event}`, do not emit metrics. The
  producer cannot tell accept from dedup, which is the point.
- On Redis unavailable: **fail open** — record the event, increment
  `observability.outcome.dedup_unavailable_total`, page the platform team.
  Losing dedup is preferable to losing the event.