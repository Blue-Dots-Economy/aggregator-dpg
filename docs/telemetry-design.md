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
- **OTel `LoggerProvider`, not pino.** stdlib / winston bridged via
  `LoggingHandler` -> OTLP. `trace_id` + `span_id` auto-injected inside active
  spans. One wire format. No file scraper.
- **Backend tier is swappable.** Change Collector `exporters:` — apps unchanged.
- **Collector is the only PII gate.** Redaction lives in one config, not in app
  code. Apps emit raw structured records.
- **One `trace_id`, three blocks, four hops.** Edge -> web -> api -> worker ->
  SignalStack. W3C TraceContext on HTTP boundaries; injected into BullMQ job
  payload across the queue boundary.

### Service block catalogue (summary; full spans + metrics in §6, §7)

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
  "dpg.block":            "api",                // web | api | worker
  deployment_environment: process.env.ENV,      // dev | staging | prod
})
```

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

### 5.2 Metrics

| Instrument        | Use for                | Example                                     |
| ----------------- | ---------------------- | ------------------------------------------- |
| `Counter`         | Monotonic counts       | `api.requests.total{route, method, status}` |
| `UpDownCounter`   | Gauges that go up/down | `worker.queue.depth{queue}`                 |
| `Histogram`       | Latency, sizes         | `api.request.duration_ms{route, method}`    |
| `ObservableGauge` | Pull-style state       | `db.pool.in_use_connections`                |

Naming: `<domain>.<object>.<unit_or_action>` — dot-delimited. Unit suffix (`_ms`, `_bytes`) where applicable.

### 5.3 Logs (OTel `LoggerProvider`)

Pino stays. A custom transport ships records via OTLP-logs so every record carries `trace_id` / `span_id` injected automatically.

Required log fields (from existing rule `logging-observability.md`, unchanged):

| Field                 | Notes                               |
| --------------------- | ----------------------------------- |
| `operation`           | `package.method` form               |
| `status`              | `success` \| `failure` \| `skipped` |
| `error`, `error_type` | failure only                        |
| `latency_ms`          | external calls                      |
| `trace_id`, `span_id` | injected by transport               |
| `aggregator_id`       | when in request context             |

### 5.4 Outcome events

Discrete business events posted async to `observability-svc`. Examples: `participant.registered`, `bulk_upload.completed`, `registration_link.expired`. Each event becomes one or more metric increments inside the Observability service — never directly in the originating service.

---

## 6. Trace Propagation

### 6.1 HTTP (browser → web BFF → api)

- **Inbound:** Fastify auto-instrumentation reads `traceparent` / `tracestate`. If absent, a new root span starts.
- **`x-request-id`:** retained as a Baggage entry (`x-request-id`) so logs and the existing reqId log label still correlate. No regression on today's behaviour.
- **Outbound:** the HTTP client (undici / fetch) auto-injects `traceparent` on every call to the API and Signals Stack.

### 6.2 BullMQ (api → redis → worker)

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

### 6.3 Async outcome emit

The outgoing POST carries `traceparent` so the Observability service span links back to the originating trace.

---

## 7. Cardinality + PII + DPDP

### 7.1 Cardinality matrix

| Attribute                                      | Type               | Allowed on metric labels?                                     | On span / log? |
| ---------------------------------------------- | ------------------ | ------------------------------------------------------------- | -------------- |
| `intent`, `state`, `status`, `route`, `method` | bounded enum       | yes                                                           | yes            |
| `aggregator_id`                                | ID (≤ 10k)         | **conditional** — only on coarse rollups, never on histograms | yes            |
| `session_id`, `turn_id`, `trace_id`            | unbounded          | **no**                                                        | yes            |
| `user_id`                                      | DPDP personal data | **never** in metrics                                          | audit log only |
| `phone`, `email`, `name`, `address`            | DPDP personal data | **never**                                                     | audit log only |
| Bulk upload `row_index`                        | unbounded          | **no**                                                        | span only      |

Hard cap: each metric must have **≤ 100 unique label combinations** in steady state. Reviewer must enforce in PR.

### 7.2 PII allow-list

Source of truth: `config.observability.audit.pii_fields_excluded`. Two separate lists:

- `audit.pii_fields_excluded` — strict; applied to the audit log path.
- `telemetry.pii_fields_excluded` — looser; applied to general traces/logs.

Pino redaction continues to apply on top — defence in depth.

### 7.3 DPDP retention

| Stream                               | Retention                              |
| ------------------------------------ | -------------------------------------- |
| Metrics (Prometheus raw)             | 30 days                                |
| Metrics (Mimir downsampled, no PII)  | 1 year                                 |
| Traces                               | 7 days                                 |
| Application logs (Loki)              | 30 days                                |
| Audit log (PII permitted, S3 sealed) | per `audit.retention_days`, default 90 |

---

## 8. Sampling Strategy

| Stage                         | Strategy                                                                              | Rationale                              |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| **Head sampling (SDK)**       | `ParentBased(TraceIdRatioBased(env_specific))` — dev `1.0`, staging `0.5`, prod `0.1` | Cheap, fast, but loses errors if blind |
| **Tail sampling (Collector)** | Always keep: errors, `latency_ms > 2000`, sampled requests w/ a flagged route         | Catches what head sampling drops       |
| **Metrics**                   | Always 100 % — sampling never applies to metrics                                      | Aggregates must be accurate            |
| **Logs**                      | Never sampled                                                                         | Log loss = blind spot                  |

Tail sampling adds memory pressure on the Collector. Sized for ≤ 100 RPS at v1.


## 9. Folder Layout

### 9.1 Shared library — `packages/telemetry`

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

### 9.2 Per-service surface

```
apps/<svc>/src/
├── telemetry.ts                # imports bootTelemetry + instruments
└── app.ts                      # await bootTelemetry() before listen()
```

### 9.3 Standalone outcome service — `apps/observability-svc/` (new)

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

## 10. Configuration

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

  audit:
    retention_days: 90
    pii_fields_excluded: [user_message, user_id, phone, email, name, address]

  telemetry:
    pii_fields_excluded: [user_message, phone, email]
```

Per-environment overrides: `config/env/{dev,staging,prod}.yaml`.

---

## 12. Code Patterns

All TypeScript. Same structure works for Python services (just swap to `opentelemetry-api` / `opentelemetry-sdk`).

### 12.1 Boot

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

### 12.2 Hot path

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

### 12.3 Outcome emit (fire-and-forget)

```ts
import { emitTurn } from '@aggregator-dpg/telemetry/outcomes';

// inside a request handler, AFTER reply.send():
queueMicrotask(() => {
  emitTurn({
    event: 'participant.created',
    attributes: { aggregator_id, participant_kind, source: 'csv' },
  }).catch(() => { /* swallow — never raise */ });
});
```

---

## 13. Async Event Endpoint (Observability service)

| Method | Path               | Body                                                                                    | Behaviour                                                                       |
| ------ | ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/emit/turn`       | Full turn payload — `event`, `attributes`, optional `tool_calls`, `latencies`, `tokens` | Always 200. Validates Zod schema, drops on parse failure with metric increment. |
| POST   | `/emit/signal`     | Discrete signal — `name`, `attributes`                                                  | Always 200.                                                                     |
| GET    | `/validate-config` | —                                                                                       | Returns loaded `observability:` config + parse warnings.                        |
| GET    | `/health`          | —                                                                                       | Liveness only.                                                                  |
| GET    | `/ready`           | —                                                                                       | Readiness — verifies OTLP exporter handshake.                                   |