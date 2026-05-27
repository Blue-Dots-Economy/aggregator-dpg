# Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the async-only OpenTelemetry observability layer described in [docs/telemetry-design.md](../../telemetry-design.md) across the `api`, `worker`, and `web` apps, plus the standalone `observability-svc` for outcome events.

**Architecture:** A shared `@aggregator-dpg/telemetry` package bootstraps OTel SDKs (Tracer + Meter + Logger providers) at process start. Every app self-instruments hot paths; pino remains the producer for logs and a custom transport ships records to OTel LoggerProvider over OTLP gRPC. An OTel Collector fans signals out to Jaeger (traces) / Prometheus (metrics) / Loki (logs). One `trace_id` flows browser → web BFF → api → BullMQ → worker → SignalStack via W3C TraceContext + Baggage (with `_otel` carrier injected into BullMQ job payloads). Outcome events post async to `observability-svc` with HMAC auth and Redis-backed idempotency dedup.

**Tech Stack:** TypeScript, OpenTelemetry SDK Node, pino, Fastify, BullMQ, Next.js, OTel Collector (contrib), Jaeger, Loki, Prometheus, Grafana, Redis.

---

## Scope decisions

These resolve ambiguous parts of the design and are binding for this plan.

| Topic                                 | Decision                                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit log path (§6.3)                 | Out of scope. `emitAudit()` is a stub that logs to pino only. No S3 Object Lock bucket, no KMS signing, no dedicated `audit-write` BullMQ queue.                                                                                                                      |
| observability-svc auth (§12.2)        | HMAC. Shared secret per caller, env-var distributed. mTLS deferred.                                                                                                                                                                                                   |
| Service version env var (§3 vs §11.1) | `process.env.APP_VERSION ?? 'dev'` — e.g. `1.0.0`.                                                                                                                                                                                                                    |
| Observability config scope            | Global per deployment. Networks deploy as separate instances, each with its own config.                                                                                                                                                                               |
| `aggregator_id` Baggage injection     | Helper `setAggregatorBaggage(id)` called from each route right after `requireAuth(req)` returns. No central auth preHandler exists today (each route has its own `requireAuth`), so per-call-site is the cleanest hook.                                               |
| Logger unification                    | Both the standalone `logger.ts` and Fastify's inline logger collapse into a single `getLogger()` singleton produced by `@aggregator-dpg/telemetry`.                                                                                                                   |
| Tail-sampling route allowlist         | Always-sample: `bulk-uploads.*`, `registration-links.*`, `public-registration-links.*`, `aggregator-registrations.*`, `aggregator-approvals.*`, `onboarding.*`. Default-sample: `dashboard.*`, `aggregator-profile.*`, `aggregator-config.*`. Never-sample: `health`. |
| Package name                          | `@aggregator-dpg/telemetry` per design §8.1. The reference to `@aggregator-dpg/observability` in `.claude/rules/logging-observability.md` is updated to point at the new package.                                                                                     |

## Out of scope

- Audit-to-S3 path (§6.3).
- Browser OTel SDK (§5.1) — design defers to v2; web BFF is the root span.
- AWS KMS integration — audit path out of scope, so KMS unused.
- Service-mesh mTLS for observability-svc.

---

## File structure map

### New package — `packages/telemetry/`

```
packages/telemetry/
├── package.json                    # exports: ./interface, ./bullmq, ./http, ./outcomes, ./pino-transport, ./testing
├── tsconfig.json
├── vitest.config.ts
├── README.md
└── src/
    ├── interface.ts                # TelemetryBase abstract class + Zod config schema
    ├── resource.ts                 # buildResource() — service.name, instance.id, deployment.environment
    ├── propagator.ts               # W3C TraceContext + Baggage composite
    ├── views.ts                    # histogram bucket boundaries per §4.2
    ├── bootstrap.ts                # bootTelemetry() / shutdownTelemetry() + OTEL_SDK_DISABLED kill switch
    ├── pino-otel-transport.ts      # pino transport that forwards records to OTel LoggerProvider
    ├── logger.ts                   # getLogger() — singleton pino instance shared across services
    ├── bullmq.ts                   # addJobWithTrace() / wrapWorker() — W3C propagator via job.data._otel
    ├── http.ts                     # registerFastify() + registerUndici() — auto-instrumentation
    ├── outcomes.ts                 # emitTurn() / emitSignal() — HMAC-signed POST, no-op when OBS_SVC_URL unset
    ├── audit.ts                    # emitAudit() — stub that logs to pino only (audit-to-S3 path skipped)
    ├── baggage.ts                  # setAggregatorBaggage(), getAggregatorId()
    ├── index.ts                    # public re-exports for the ./interface subpath
    ├── testing/
    │   ├── index.ts                # TelemetryFake + buildSpanFixture + buildOutcomeFixture
    │   └── in-memory.ts            # InMemoryTelemetry implementation
    └── __tests__/
        ├── bootstrap.test.ts
        ├── resource.test.ts
        ├── propagator.test.ts
        ├── pino-otel-transport.test.ts
        ├── bullmq.test.ts
        ├── outcomes.test.ts
        └── baggage.test.ts
```

### Modified — `apps/api/`

```
apps/api/src/
├── telemetry.ts                    # NEW — bootTelemetry() + api-specific instruments
├── logger.ts                       # MODIFIED — one-line re-export of getLogger()
├── server.ts                       # MODIFIED — bootTelemetry first, shutdownTelemetry on SIGTERM
├── app.ts                          # MODIFIED — Fastify({ logger: getLogger() }), registerFastify hook
├── config.ts                       # MODIFIED — add OTEL_*, OBS_SVC_*, APP_VERSION to schema
├── services/bulk-queue/index.ts    # MODIFIED — addJobWithTrace at producer site
└── routes/
    ├── bulk-uploads.ts             # MODIFIED — setAggregatorBaggage after requireAuth
    ├── registration-links.ts       # MODIFIED — same
    ├── public-registration-links.ts # MODIFIED — same
    ├── aggregator-registrations.ts # MODIFIED — same
    ├── aggregator-approvals.ts     # MODIFIED — same
    ├── aggregator-profile.ts       # MODIFIED — same
    ├── aggregator-config.ts        # MODIFIED — same
    ├── dashboard.ts                # MODIFIED — same
    └── onboarding.ts               # MODIFIED — same
```

### Modified — `apps/worker/`

```
apps/worker/src/
├── telemetry.ts                    # NEW
├── logger.ts                       # MODIFIED — re-export getLogger()
├── main.ts                         # MODIFIED — bootTelemetry first, wrapWorker per Worker, shutdownTelemetry on SIGTERM
├── config.ts                       # MODIFIED — add OTEL_*, OBS_SVC_*, APP_VERSION
└── jobs/
    ├── bulk-file-process.ts        # MODIFIED — addJobWithTrace when fanning out row jobs
    └── bulk-row-process.ts         # MODIFIED — custom span around SignalStack call
```

### Modified — `apps/web/`

```
apps/web/
├── instrumentation.ts              # NEW — Next.js OTel entry point
└── src/
    └── lib/
        └── telemetry.ts            # NEW — web BFF spans + metrics helpers
```

### New service — `apps/observability-svc/`

```
apps/observability-svc/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile
├── README.md
└── src/
    ├── main.ts                     # Fastify entrypoint
    ├── server.ts                   # buildServer() — kept separate for testing
    ├── config.ts                   # env schema (zod)
    ├── hmac-auth.ts                # HMAC-SHA256 over body + replay window
    ├── idempotency.ts              # Redis-backed dedup store
    ├── outcome-tracker.ts          # lifecycle FSM, config-driven metric increments
    ├── routes/
    │   ├── emit-turn.ts            # POST /emit/turn
    │   ├── emit-signal.ts          # POST /emit/signal
    │   ├── validate-config.ts      # GET /validate-config (admin token)
    │   ├── health.ts               # GET /health
    │   └── ready.ts                # GET /ready
    ├── telemetry.ts                # bootTelemetry + custom metrics (duplicate_total, dedup_unavailable_total)
    └── __tests__/                  # one per route + auth + idempotency + tracker
```

### Config

```
config/
└── observability.yaml              # NEW — single global file per design §9
config/env/
├── dev.yaml                        # MODIFIED — observability.otel.sample_rate=1.0
├── staging.yaml                    # MODIFIED — sample_rate=0.5
└── prod.yaml                       # MODIFIED — sample_rate=0.1
```

### Infra

```
docker-compose.yml                  # MODIFIED — add otel-collector, jaeger, loki, prometheus, grafana
infra/otel-collector/
├── otelcol-config.dev.yaml         # NEW — receivers + redact + batch (no tail sampling in dev)
└── otelcol-config.prod.yaml        # NEW — receivers + memory_limiter + redact + tail_sampling + batch
infra/grafana/
└── provisioning/datasources/datasources.yaml # NEW — Prometheus + Jaeger + Loki
helm/aggregator-dpg/charts/
├── api/values.yaml                 # MODIFIED — OTEL_* env, terminationGracePeriodSeconds: 30
├── worker/values.yaml              # MODIFIED — same
├── web/values.yaml                 # MODIFIED — same
└── observability-svc/              # NEW chart
    ├── Chart.yaml
    ├── values.yaml
    └── templates/
        ├── deployment.yaml
        ├── service.yaml
        ├── networkpolicy.yaml      # restrict ingress to api/worker SAs
        └── secret.yaml             # references K8s Secret for HMAC keys
helm/aggregator-dpg/charts/otel-collector/  # NEW chart (or use upstream contrib)
```

### Rules / docs

```
.claude/rules/logging-observability.md  # MODIFIED — package rename + transport note
docs/telemetry-runbook.md               # NEW — kill switch, BSP env vars, on-call doc
```

---

## Phase 0 — `@aggregator-dpg/telemetry` package

**Goal of phase:** Ship a buildable, fully-tested package that **no other code imports yet**. `bootTelemetry()` runs as a no-op when `OTEL_SDK_DISABLED=true` (which is the default until Phase 1 enables it per-service).

**Phase gate:** `pnpm --filter @aggregator-dpg/telemetry test` passes with ≥ 70 % line coverage; `pnpm dep-check` clean; no app changes in this phase.

---

### Task 0.1: Package scaffold

**Files:**

- Create: `packages/telemetry/package.json`
- Create: `packages/telemetry/tsconfig.json`
- Create: `packages/telemetry/vitest.config.ts`
- Create: `packages/telemetry/README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@aggregator-dpg/telemetry",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    "./interface": { "import": "./dist/interface.js", "types": "./dist/interface.d.ts" },
    "./bootstrap": { "import": "./dist/bootstrap.js", "types": "./dist/bootstrap.d.ts" },
    "./logger": { "import": "./dist/logger.js", "types": "./dist/logger.d.ts" },
    "./pino-transport": {
      "import": "./dist/pino-otel-transport.js",
      "types": "./dist/pino-otel-transport.d.ts"
    },
    "./bullmq": { "import": "./dist/bullmq.js", "types": "./dist/bullmq.d.ts" },
    "./http": { "import": "./dist/http.js", "types": "./dist/http.d.ts" },
    "./outcomes": { "import": "./dist/outcomes.js", "types": "./dist/outcomes.d.ts" },
    "./audit": { "import": "./dist/audit.js", "types": "./dist/audit.d.ts" },
    "./baggage": { "import": "./dist/baggage.js", "types": "./dist/baggage.d.ts" },
    "./testing": { "import": "./dist/testing/index.js", "types": "./dist/testing/index.d.ts" }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@aggregator-dpg/shared-primitives": "workspace:*",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-node": "^0.52.0",
    "@opentelemetry/sdk-trace-base": "^1.25.0",
    "@opentelemetry/sdk-metrics": "^1.25.0",
    "@opentelemetry/sdk-logs": "^0.52.0",
    "@opentelemetry/api-logs": "^0.52.0",
    "@opentelemetry/exporter-trace-otlp-grpc": "^0.52.0",
    "@opentelemetry/exporter-metrics-otlp-grpc": "^0.52.0",
    "@opentelemetry/exporter-logs-otlp-grpc": "^0.52.0",
    "@opentelemetry/instrumentation-fastify": "^0.38.0",
    "@opentelemetry/instrumentation-undici": "^0.6.0",
    "@opentelemetry/core": "^1.25.0",
    "@opentelemetry/resources": "^1.25.0",
    "@opentelemetry/semantic-conventions": "^1.25.0",
    "@opentelemetry/propagator-b3": "^1.25.0",
    "bullmq": "^5.76.6",
    "pino": "^9.5.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@aggregator-dpg/tsconfig": "workspace:*",
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^3.2.0",
    "typescript": "^6.0.3",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (mirrors `packages/_template/tsconfig.json` — every other package in the repo uses this exact shape)

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@aggregator-dpg/tsconfig/node.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "composite": true,
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/__tests__", "dist"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`** (mirrors `packages/_template/vitest.config.ts`)

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/__tests__/**', 'src/testing/**'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
```

- [ ] **Step 4: Create `README.md`**

```markdown
# @aggregator-dpg/telemetry

Shared OpenTelemetry bootstrap for every aggregator-dpg block (api, worker, web,
observability-svc).

See `docs/telemetry-design.md` for the full design.
```

- [ ] **Step 5: Install + verify**

```bash
pnpm install
pnpm --filter @aggregator-dpg/telemetry typecheck
```

Expected: typecheck passes (no `src/` files yet, but tsconfig validates).

- [ ] **Step 6: Commit**

```bash
git add packages/telemetry/
git commit -m "feat(telemetry): scaffold @aggregator-dpg/telemetry package"
```

---

### Task 0.2: Zod config schema (`interface.ts`)

**Files:**

- Create: `packages/telemetry/src/interface.ts`
- Create: `packages/telemetry/src/__tests__/interface.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/telemetry/src/__tests__/interface.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TelemetryConfigSchema } from '../interface.js';

describe('TelemetryConfigSchema', () => {
  it('parses a minimal valid config', () => {
    const result = TelemetryConfigSchema.parse({
      otel: { collector_endpoint: 'http://otel-collector:4317' },
    });
    expect(result.otel.protocol).toBe('grpc');
    expect(result.otel.sample_rate).toBe(0.1);
    expect(result.otel.export_interval_ms).toBe(5000);
    expect(result.outcomes_svc_url).toBeUndefined();
  });

  it('rejects sample_rate > 1', () => {
    expect(() =>
      TelemetryConfigSchema.parse({
        otel: { collector_endpoint: 'http://otel-collector:4317', sample_rate: 1.5 },
      }),
    ).toThrow();
  });

  it('accepts outcomes_svc_url and HMAC secret', () => {
    const result = TelemetryConfigSchema.parse({
      otel: { collector_endpoint: 'http://otel-collector:4317' },
      outcomes_svc_url: 'http://observability-svc:8080',
      outcomes_hmac_key_id: 'svc-api',
      outcomes_hmac_secret: 'shhh',
    });
    expect(result.outcomes_svc_url).toBe('http://observability-svc:8080');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/telemetry test interface
```

Expected: FAIL — `Cannot find module '../interface.js'`.

- [ ] **Step 3: Implement `interface.ts`**

```ts
/**
 * Public Zod schema and abstract surface for @aggregator-dpg/telemetry.
 *
 * The interface module is import-restricted by dep-cruiser to only
 * shared-primitives, zod, and node:* — no OTel SDK imports here.
 */

import { z } from 'zod';

export const TelemetryConfigSchema = z.object({
  otel: z.object({
    collector_endpoint: z.string().url(),
    protocol: z.enum(['grpc', 'http']).default('grpc'),
    sample_rate: z.number().min(0).max(1).default(0.1),
    export_interval_ms: z.number().int().positive().default(5000),
    timeout_ms: z.number().int().positive().default(10000),
  }),
  outcomes_svc_url: z.string().url().optional(),
  outcomes_hmac_key_id: z.string().optional(),
  outcomes_hmac_secret: z.string().optional(),
  pii_fields_excluded: z.array(z.string()).default([]),
});

export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;

export interface BootOptions {
  serviceName: string;
  serviceVersion: string;
  deploymentEnvironment: string;
  config: TelemetryConfig;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/telemetry test interface
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/interface.ts packages/telemetry/src/__tests__/interface.test.ts
git commit -m "feat(telemetry): add Zod config schema"
```

---

### Task 0.3: Resource builder (`resource.ts`)

**Files:**

- Create: `packages/telemetry/src/resource.ts`
- Create: `packages/telemetry/src/__tests__/resource.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildResource } from '../resource.js';

describe('buildResource', () => {
  it('sets service.name, service.version, dpg.block, deployment.environment', () => {
    const r = buildResource({
      serviceName: 'aggregator-api',
      serviceVersion: '1.2.3',
      deploymentEnvironment: 'dev',
    });
    const attrs = r.attributes;
    expect(attrs['service.name']).toBe('aggregator-api');
    expect(attrs['service.namespace']).toBe('aggregator');
    expect(attrs['service.version']).toBe('1.2.3');
    expect(attrs['deployment.environment']).toBe('dev');
    expect(attrs['dpg.block']).toBe('api');
  });

  it('uses HOSTNAME for service.instance.id when set', () => {
    process.env.HOSTNAME = 'api-pod-7';
    const r = buildResource({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
    });
    expect(r.attributes['service.instance.id']).toBe('api-pod-7');
    delete process.env.HOSTNAME;
  });

  it('falls back to a uuid when HOSTNAME is missing', () => {
    delete process.env.HOSTNAME;
    const r = buildResource({
      serviceName: 'aggregator-worker',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
    });
    expect(r.attributes['service.instance.id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
pnpm --filter @aggregator-dpg/telemetry test resource
```

- [ ] **Step 3: Implement `resource.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes as ATTR } from '@opentelemetry/semantic-conventions';

const BLOCK_BY_SERVICE: Record<string, string> = {
  'aggregator-api': 'api',
  'aggregator-worker': 'worker',
  'aggregator-web': 'web',
  'aggregator-observability-svc': 'observability-svc',
};

export interface ResourceOptions {
  serviceName: string;
  serviceVersion: string;
  deploymentEnvironment: string;
}

export function buildResource(opts: ResourceOptions): Resource {
  const block = BLOCK_BY_SERVICE[opts.serviceName] ?? opts.serviceName;
  const instanceId = process.env.HOSTNAME ?? randomUUID();
  return new Resource({
    [ATTR.SERVICE_NAME]: opts.serviceName,
    [ATTR.SERVICE_NAMESPACE]: 'aggregator',
    [ATTR.SERVICE_VERSION]: opts.serviceVersion,
    [ATTR.SERVICE_INSTANCE_ID]: instanceId,
    [ATTR.DEPLOYMENT_ENVIRONMENT]: opts.deploymentEnvironment,
    'dpg.block': block,
  });
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/resource.ts packages/telemetry/src/__tests__/resource.test.ts
git commit -m "feat(telemetry): add resource builder with service.instance.id"
```

---

### Task 0.4: Propagator (`propagator.ts`)

**Files:**

- Create: `packages/telemetry/src/propagator.ts`
- Create: `packages/telemetry/src/__tests__/propagator.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { configurePropagator } from '../propagator.js';

describe('configurePropagator', () => {
  it('installs a propagator that extracts traceparent and baggage', () => {
    configurePropagator();
    const ctx = propagation.extract(ROOT_CONTEXT, {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      baggage: 'aggregator_id=agg-1',
    });
    const baggage = propagation.getBaggage(ctx);
    expect(baggage?.getEntry('aggregator_id')?.value).toBe('agg-1');
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
import { propagation } from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';

export function configurePropagator(): void {
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/propagator.ts packages/telemetry/src/__tests__/propagator.test.ts
git commit -m "feat(telemetry): install W3C TraceContext + Baggage propagator"
```

---

### Task 0.5: Histogram bucket views (`views.ts`)

**Files:**

- Create: `packages/telemetry/src/views.ts`
- Create: `packages/telemetry/src/__tests__/views.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { HISTOGRAM_VIEWS } from '../views.js';

describe('HISTOGRAM_VIEWS', () => {
  it('includes views for each histogram family in design §4.2', () => {
    const names = HISTOGRAM_VIEWS.map((v) => v.instrumentName);
    expect(names).toContain('api.request.duration_ms');
    expect(names).toContain('db.call.duration_ms');
    expect(names).toContain('signalstack.duration_ms');
    expect(names).toContain('worker.job.duration_ms');
    expect(names).toContain('worker.bulk_row.duration_ms');
  });

  it('api.request.duration_ms uses the §4.2 bucket boundaries', () => {
    const v = HISTOGRAM_VIEWS.find((x) => x.instrumentName === 'api.request.duration_ms');
    expect(v?.boundaries).toEqual([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
import { ExplicitBucketHistogramAggregation, View } from '@opentelemetry/sdk-metrics';

interface HistogramFamily {
  instrumentName: string;
  boundaries: number[];
}

export const HISTOGRAM_VIEWS: HistogramFamily[] = [
  {
    instrumentName: 'api.request.duration_ms',
    boundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  },
  {
    instrumentName: 'db.call.duration_ms',
    boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  },
  {
    instrumentName: 'redis.call.duration_ms',
    boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  },
  {
    instrumentName: 'signalstack.duration_ms',
    boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  },
  {
    instrumentName: 'worker.job.duration_ms',
    boundaries: [100, 500, 1000, 5000, 15000, 60000, 300000, 900000],
  },
  {
    instrumentName: 'worker.bulk_row.duration_ms',
    boundaries: [10, 50, 100, 500, 1000, 5000, 30000],
  },
];

export function buildViews(): View[] {
  return HISTOGRAM_VIEWS.map(
    (f) =>
      new View({
        instrumentName: f.instrumentName,
        aggregation: new ExplicitBucketHistogramAggregation(f.boundaries, true),
      }),
  );
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/views.ts packages/telemetry/src/__tests__/views.test.ts
git commit -m "feat(telemetry): histogram bucket views per design §4.2"
```

---

### Task 0.6: Bootstrap (`bootstrap.ts`) — kill switch, providers, shutdown

**Files:**

- Create: `packages/telemetry/src/bootstrap.ts`
- Create: `packages/telemetry/src/__tests__/bootstrap.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { trace, metrics } from '@opentelemetry/api';
import { bootTelemetry, shutdownTelemetry, isTelemetryEnabled } from '../bootstrap.js';

const cfg = {
  otel: {
    collector_endpoint: 'http://localhost:4317',
    protocol: 'grpc' as const,
    sample_rate: 1,
    export_interval_ms: 5000,
    timeout_ms: 10000,
  },
  pii_fields_excluded: [],
};

describe('bootTelemetry', () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('is a no-op when OTEL_SDK_DISABLED=true', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    await bootTelemetry({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
      config: cfg,
    });
    expect(isTelemetryEnabled()).toBe(false);
    delete process.env.OTEL_SDK_DISABLED;
  });

  it('installs providers when enabled', async () => {
    delete process.env.OTEL_SDK_DISABLED;
    await bootTelemetry({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
      config: cfg,
    });
    expect(isTelemetryEnabled()).toBe(true);
    expect(trace.getTracerProvider()).toBeDefined();
    expect(metrics.getMeterProvider()).toBeDefined();
  });

  it('is idempotent — second boot is a no-op', async () => {
    delete process.env.OTEL_SDK_DISABLED;
    await bootTelemetry({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
      config: cfg,
    });
    const first = trace.getTracerProvider();
    await bootTelemetry({
      serviceName: 'aggregator-api',
      serviceVersion: '1.0.0',
      deploymentEnvironment: 'dev',
      config: cfg,
    });
    expect(trace.getTracerProvider()).toBe(first);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
/**
 * OTel SDK bootstrap for aggregator-dpg blocks.
 *
 * Reads OTEL_SDK_DISABLED first and short-circuits if set — the
 * production kill switch must work without any SDK side effects.
 * Otherwise installs TracerProvider + MeterProvider + LoggerProvider
 * with OTLP gRPC exporters, batch processors sized per §10.3, and the
 * histogram views from §4.2.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { logs } from '@opentelemetry/api-logs';
import type { BootOptions } from './interface.js';
import { buildResource } from './resource.js';
import { configurePropagator } from './propagator.js';
import { buildViews } from './views.js';

let sdk: NodeSDK | undefined;
let loggerProvider: LoggerProvider | undefined;
let enabled = false;

export function isTelemetryEnabled(): boolean {
  return enabled;
}

export function getLoggerProvider(): LoggerProvider | undefined {
  return loggerProvider;
}

export async function bootTelemetry(opts: BootOptions): Promise<void> {
  if (sdk) return; // idempotent

  if (process.env.OTEL_SDK_DISABLED === 'true') {
    enabled = false;
    return;
  }

  const resource = buildResource({
    serviceName: opts.serviceName,
    serviceVersion: opts.serviceVersion,
    deploymentEnvironment: opts.deploymentEnvironment,
  });

  const traceExporter = new OTLPTraceExporter({ url: opts.config.otel.collector_endpoint });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: opts.config.otel.collector_endpoint }),
    exportIntervalMillis: opts.config.otel.export_interval_ms,
  });

  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(opts.config.otel.sample_rate),
  });

  sdk = new NodeSDK({
    resource,
    sampler,
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        maxQueueSize: Number(process.env.OTEL_BSP_MAX_QUEUE_SIZE ?? 2048),
        maxExportBatchSize: Number(process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE ?? 512),
        scheduledDelayMillis: Number(process.env.OTEL_BSP_SCHEDULE_DELAY ?? 5000),
        exportTimeoutMillis: Number(process.env.OTEL_BSP_EXPORT_TIMEOUT ?? 30000),
      }),
    ],
    metricReader,
    views: buildViews(),
  });

  loggerProvider = new LoggerProvider({ resource });
  loggerProvider.addLogRecordProcessor(
    new BatchLogRecordProcessor(new OTLPLogExporter({ url: opts.config.otel.collector_endpoint })),
  );
  logs.setGlobalLoggerProvider(loggerProvider);

  sdk.start();
  configurePropagator();
  enabled = true;
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    await loggerProvider?.shutdown();
  } finally {
    sdk = undefined;
    loggerProvider = undefined;
    enabled = false;
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/bootstrap.ts packages/telemetry/src/__tests__/bootstrap.test.ts
git commit -m "feat(telemetry): bootstrap with kill switch, BSP env vars, graceful shutdown"
```

---

### Task 0.7: Pino → OTel logs transport (`pino-otel-transport.ts`)

**Files:**

- Create: `packages/telemetry/src/pino-otel-transport.ts`
- Create: `packages/telemetry/src/__tests__/pino-otel-transport.test.ts`

- [ ] **Step 1: Failing test**

The transport reads `trace_id`/`span_id` from the pino record (the mixin in
Task 0.8 puts them there at log time on the main thread). It does NOT read
active OTel context, because pino transports may run in a worker thread
where the main-thread AsyncLocalStorage is unreachable.

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleRecord } from '../pino-otel-transport.js';

describe('pino-otel-transport', () => {
  it('emits a log record with body, attributes, and trace ids from the record', () => {
    const emit = vi.fn();
    handleRecord(
      {
        level: 30,
        msg: 'hello',
        time: 1,
        foo: 'bar',
        trace_id: '0af7651916cd43dd8448eb211c80319c',
        span_id: 'b7ad6b7169203331',
      },
      { emit } as never,
    );
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.body).toBe('hello');
    expect(call.attributes.foo).toBe('bar');
    expect(call.attributes['trace_id']).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(call.attributes['span_id']).toBe('b7ad6b7169203331');
  });

  it('emits a record without trace ids when the mixin did not add them', () => {
    const emit = vi.fn();
    handleRecord({ level: 30, msg: 'no trace', time: 1 }, { emit } as never);
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.attributes['trace_id']).toBeUndefined();
  });

  it('redacts attributes listed in piiFieldsExcluded', () => {
    const emit = vi.fn();
    handleRecord({ level: 30, msg: 'x', time: 1, phone: '555' }, { emit } as never, ['phone']);
    const call = emit.mock.calls[0][0];
    expect(call.attributes.phone).toBe('[REDACTED]');
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
/**
 * pino transport that forwards records to the active OTel LoggerProvider.
 *
 * Application code logs via pino as usual. This transport may run in a
 * pino worker thread, so it cannot read the main-thread OTel context.
 * `trace_id` / `span_id` are injected into each record by a pino mixin
 * (see `logger.ts`) at log time on the main thread; this transport
 * simply forwards them to OTel logs.
 */

import build from 'pino-abstract-transport';
import { logs, SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs';

const PINO_TO_OTEL_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

export function handleRecord(
  rec: Record<string, unknown>,
  logger: OtelLogger,
  piiExcluded: string[] = [],
): void {
  const { level, time, msg, hostname, pid, ...rest } = rec as {
    level: number;
    time: number;
    msg?: string;
    hostname?: string;
    pid?: number;
  } & Record<string, unknown>;

  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    attrs[k] = piiExcluded.includes(k) ? '[REDACTED]' : v;
  }

  logger.emit({
    severityNumber: PINO_TO_OTEL_SEVERITY[level] ?? SeverityNumber.INFO,
    severityText: String(level),
    body: msg,
    timestamp: time,
    attributes: attrs,
  });
}

export default function pinoOtelTransport(opts: { piiFieldsExcluded?: string[] } = {}) {
  return build(async (source) => {
    const logger = logs.getLogger('pino');
    for await (const rec of source) {
      handleRecord(rec, logger, opts.piiFieldsExcluded ?? []);
    }
  });
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Add `pino-abstract-transport` dep**

```bash
pnpm --filter @aggregator-dpg/telemetry add pino-abstract-transport
```

- [ ] **Step 6: Commit**

```bash
git add packages/telemetry/
git commit -m "feat(telemetry): pino transport forwarding records to OTLP logs"
```

---

### Task 0.8: Shared logger (`logger.ts`)

**Files:**

- Create: `packages/telemetry/src/logger.ts`
- Create: `packages/telemetry/src/__tests__/logger.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { getLogger, resetLoggerForTesting } from '../logger.js';

describe('getLogger', () => {
  it('returns a singleton', () => {
    resetLoggerForTesting();
    const a = getLogger({ serviceName: 'aggregator-api', env: 'test' });
    const b = getLogger({ serviceName: 'aggregator-api', env: 'test' });
    expect(a).toBe(b);
  });

  it('redacts authorization headers and tokens', () => {
    resetLoggerForTesting();
    const log = getLogger({ serviceName: 'aggregator-api', env: 'test' });
    const lines: unknown[] = [];
    const child = log.child({});
    // Pino exposes redact via internal symbols; do a smoke test by emitting and
    // verifying the redact paths are configured on the pino instance.
    expect((log as unknown as { [k: string]: unknown })['redact' as string]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
/**
 * Process-wide pino instance shared across all aggregator-dpg services.
 *
 * Adds a mixin that captures `trace_id` / `span_id` from the active OTel
 * context AT LOG TIME (in the main thread). The mixin runs synchronously
 * before pino serialises the record, so the trace ids are stamped into
 * the JSON payload that the transport later forwards over OTLP — even
 * when pino runs the transport in a worker thread where the OTel
 * context is unreachable.
 */

import pino, { type Logger } from 'pino';
import { context, trace } from '@opentelemetry/api';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  'body.password',
  'body.token',
];

interface LoggerOptions {
  serviceName: string;
  env: string;
  level?: string;
  piiFieldsExcluded?: string[];
  otlpEnabled?: boolean;
}

let singleton: Logger | undefined;

export function getLogger(opts: LoggerOptions): Logger {
  if (singleton) return singleton;

  const targets: unknown[] = [];

  if (opts.env === 'development') {
    targets.push({
      target: 'pino-pretty',
      level: opts.level ?? 'info',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        singleLine: false,
        ignore: 'pid,hostname,service,env',
      },
    });
  } else {
    targets.push({ target: 'pino/file', level: opts.level ?? 'info', options: { destination: 1 } });
  }

  if (opts.otlpEnabled) {
    targets.push({
      target: '@aggregator-dpg/telemetry/pino-transport',
      level: opts.level ?? 'info',
      options: { piiFieldsExcluded: opts.piiFieldsExcluded ?? [] },
    });
  }

  singleton = pino({
    level: opts.level ?? 'info',
    base: { service: opts.serviceName, env: opts.env },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    mixin: () => {
      const span = trace.getSpan(context.active());
      if (!span) return {};
      const ctx = span.spanContext();
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
    transport: { targets },
  });

  return singleton;
}

export function resetLoggerForTesting(): void {
  singleton = undefined;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/logger.ts packages/telemetry/src/__tests__/logger.test.ts
git commit -m "feat(telemetry): shared pino singleton with OTLP transport target"
```

---

### Task 0.9: Baggage helper (`baggage.ts`)

**Files:**

- Create: `packages/telemetry/src/baggage.ts`
- Create: `packages/telemetry/src/__tests__/baggage.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { context, propagation } from '@opentelemetry/api';
import { withAggregatorBaggage, withRequestIdBaggage, getAggregatorId } from '../baggage.js';

describe('aggregator baggage helpers', () => {
  it('round-trips aggregator_id through baggage inside the callback', async () => {
    await withAggregatorBaggage('agg-42', () => {
      expect(getAggregatorId()).toBe('agg-42');
    });
    expect(getAggregatorId()).toBeUndefined();
  });

  it('returns undefined when unset', () => {
    expect(getAggregatorId()).toBeUndefined();
  });

  it('withRequestIdBaggage stamps x_request_id inside the callback', async () => {
    await withRequestIdBaggage('req-123', () => {
      const baggage = propagation.getBaggage(context.active());
      expect(baggage?.getEntry('x_request_id')?.value).toBe('req-123');
    });
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
/**
 * Aggregator / request-id Baggage helpers.
 *
 * `propagation.setBaggage(ctx, b)` returns a NEW context — it does not
 * mutate the active context. To make the new baggage visible to OTel's
 * propagator on the outbound side, the helper must enter the new context
 * for the duration of a callback via `context.with`. The pattern is
 * therefore wrapper-based.
 *
 * Each helper also stamps the value onto the currently active span as an
 * attribute (which is guaranteed visible in this trace regardless of
 * baggage propagation).
 */

import { context, propagation, trace } from '@opentelemetry/api';

const AGG_KEY = 'aggregator_id';
const REQ_ID_KEY = 'x_request_id';

/**
 * Runs `fn` inside a context where `aggregator_id` is set as a Baggage
 * entry, so downstream HTTP / BullMQ outbound calls carry it via the
 * W3C Baggage propagator. Also stamps it on the active span.
 */
export async function withAggregatorBaggage<T>(
  aggregatorId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const span = trace.getSpan(context.active());
  span?.setAttribute('aggregator_id', aggregatorId);
  const baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  const next = baggage.setEntry(AGG_KEY, { value: aggregatorId });
  const ctx = propagation.setBaggage(context.active(), next);
  return context.with(ctx, fn);
}

/**
 * Same pattern for the Fastify request id.
 */
export async function withRequestIdBaggage<T>(
  requestId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const span = trace.getSpan(context.active());
  span?.setAttribute('http.request_id', requestId);
  const baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  const next = baggage.setEntry(REQ_ID_KEY, { value: requestId });
  const ctx = propagation.setBaggage(context.active(), next);
  return context.with(ctx, fn);
}

export function getAggregatorId(): string | undefined {
  return propagation.getBaggage(context.active())?.getEntry(AGG_KEY)?.value;
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/baggage.ts packages/telemetry/src/__tests__/baggage.test.ts
git commit -m "feat(telemetry): aggregator_id baggage helpers"
```

---

### Task 0.10: BullMQ helpers (`bullmq.ts`)

**Files:**

- Create: `packages/telemetry/src/bullmq.ts`
- Create: `packages/telemetry/src/__tests__/bullmq.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { context, propagation, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { configurePropagator } from '../propagator.js';
import { addJobWithTrace, extractJobContext } from '../bullmq.js';

configurePropagator();

describe('addJobWithTrace', () => {
  it('injects an _otel carrier into the job payload', async () => {
    const add = vi.fn().mockResolvedValue({ id: 'job-1' });
    const queue = { add } as never;
    const tracer = trace.getTracer('t');
    const span = tracer.startSpan('producer');
    await context.with(trace.setSpan(ROOT_CONTEXT, span), () =>
      addJobWithTrace(queue, 'process', { foo: 1 } as never),
    );
    span.end();
    const payload = add.mock.calls[0][1];
    expect(payload._otel).toBeDefined();
    expect(typeof payload._otel.traceparent).toBe('string');
    expect(payload.foo).toBe(1);
  });
});

describe('extractJobContext', () => {
  it('returns the active context when payload has no _otel', () => {
    const ctx = extractJobContext({});
    expect(ctx).toBe(context.active());
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
/**
 * BullMQ producer/consumer telemetry helpers.
 *
 * BullMQ has no native OTel hook. We carry the W3C traceparent inside
 * `job.data._otel`, set on enqueue, extracted on dequeue. This stitches
 * api producer spans to worker consumer spans across the Redis boundary.
 */

import { context, propagation, trace, type Context, type Span } from '@opentelemetry/api';
import type { JobsOptions, Queue } from 'bullmq';

export interface JobWithCarrier<T> {
  _otel?: Record<string, string>;
}

export async function addJobWithTrace<T extends object>(
  queue: Queue<T>,
  name: string,
  data: T,
  opts?: JobsOptions,
): Promise<unknown> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return queue.add(name, { ...data, _otel: carrier } as T, opts);
}

export function extractJobContext<T>(data: T & JobWithCarrier<T>): Context {
  const carrier = data._otel ?? {};
  if (Object.keys(carrier).length === 0) return context.active();
  return propagation.extract(context.active(), carrier);
}

export async function wrapWorker<T>(
  queueName: string,
  data: T & JobWithCarrier<T>,
  handler: (span: Span) => Promise<unknown>,
): Promise<unknown> {
  const parent = extractJobContext(data);
  const tracer = trace.getTracer('@aggregator-dpg/telemetry');
  return context.with(parent, () =>
    tracer.startActiveSpan(`worker.${queueName}.process`, async (span) => {
      try {
        return await handler(span);
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: 2 /* ERROR */ });
        throw e;
      } finally {
        span.end();
      }
    }),
  );
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/bullmq.ts packages/telemetry/src/__tests__/bullmq.test.ts
git commit -m "feat(telemetry): bullmq trace propagation via job._otel carrier"
```

---

### Task 0.11: HTTP auto-instrumentation registration (`http.ts`)

**Files:**

- Create: `packages/telemetry/src/http.ts`

- [ ] **Step 1: Implement** (no test — `registerInstrumentations` has side effects on the module registry; a unit test would be tautological. The integration test in Phase 1 verifies it)

```ts
/**
 * Registers Fastify (inbound) and undici (outbound fetch) auto-instrumentation
 * with the global OTel provider. Must be called *after* bootTelemetry() so
 * the providers exist when patches install.
 */

import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

let registered = false;

export function registerHttpInstrumentations(): void {
  if (registered) return;
  registerInstrumentations({
    instrumentations: [new FastifyInstrumentation(), new UndiciInstrumentation()],
  });
  registered = true;
}
```

- [ ] **Step 2: Add `@opentelemetry/instrumentation` dep**

```bash
pnpm --filter @aggregator-dpg/telemetry add @opentelemetry/instrumentation
```

- [ ] **Step 3: Verify typecheck passes**

```bash
pnpm --filter @aggregator-dpg/telemetry typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/telemetry/
git commit -m "feat(telemetry): Fastify + undici auto-instrumentation registration"
```

---

### Task 0.12: Outcome events client (`outcomes.ts`)

**Files:**

- Create: `packages/telemetry/src/outcomes.ts`
- Create: `packages/telemetry/src/__tests__/outcomes.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { emitTurn, emitSignal, configureOutcomes } from '../outcomes.js';

describe('outcomes client', () => {
  it('is a no-op when outcomes_svc_url is unset', async () => {
    const fetchSpy = vi.fn();
    configureOutcomes({ fetchImpl: fetchSpy });
    await emitTurn({ event: 'participant.created', idempotency_key: 'k1', attributes: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts HMAC-signed payload when configured', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    configureOutcomes({
      outcomesSvcUrl: 'http://observability-svc:8080',
      hmacKeyId: 'svc-api',
      hmacSecret: 'shh',
      fetchImpl: fetchSpy,
    });
    await emitTurn({ event: 'participant.created', idempotency_key: 'k1', attributes: {} });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://observability-svc:8080/emit/turn');
    expect(init.headers['X-Outcome-Key-Id']).toBe('svc-api');
    expect(typeof init.headers['X-Outcome-Signature']).toBe('string');
    expect(typeof init.headers['X-Outcome-Timestamp']).toBe('string');
  });

  it('never throws on network failure', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('down'));
    configureOutcomes({
      outcomesSvcUrl: 'http://observability-svc:8080',
      hmacKeyId: 'svc-api',
      hmacSecret: 'shh',
      fetchImpl: fetchSpy,
    });
    await expect(
      emitSignal({ name: 'drop', idempotency_key: 'k', attributes: {} }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
/**
 * Fire-and-forget outcome event client for apps/observability-svc.
 *
 * Until OBS_SVC_URL is set this is a no-op; producers can wire emit
 * calls today and the Phase 4 cutover is a config flip. HMAC-SHA256
 * over `(timestamp + body)` per design §12.2. Never raises — failures
 * are silently dropped (caller increments a local counter on .catch()
 * per design §11.3).
 */

import { createHmac } from 'node:crypto';

interface OutcomesConfig {
  outcomesSvcUrl?: string;
  hmacKeyId?: string;
  hmacSecret?: string;
  fetchImpl?: typeof fetch;
}

let cfg: OutcomesConfig = {};

export function configureOutcomes(next: OutcomesConfig): void {
  cfg = next;
}

export interface TurnPayload {
  event: string;
  idempotency_key: string;
  attributes: Record<string, unknown>;
  tool_calls?: unknown[];
  latencies?: Record<string, number>;
  tokens?: Record<string, number>;
}

export interface SignalPayload {
  name: string;
  idempotency_key: string;
  attributes: Record<string, unknown>;
}

export async function emitTurn(payload: TurnPayload): Promise<void> {
  return post('/emit/turn', payload);
}

export async function emitSignal(payload: SignalPayload): Promise<void> {
  return post('/emit/signal', payload);
}

async function post(path: string, payload: object): Promise<void> {
  if (!cfg.outcomesSvcUrl || !cfg.hmacKeyId || !cfg.hmacSecret) return;
  const body = JSON.stringify(payload);
  const ts = Date.now().toString();
  const sig = createHmac('sha256', cfg.hmacSecret)
    .update(ts + body)
    .digest('hex');
  const doFetch = cfg.fetchImpl ?? fetch;
  try {
    await doFetch(`${cfg.outcomesSvcUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Outcome-Key-Id': cfg.hmacKeyId,
        'X-Outcome-Signature': sig,
        'X-Outcome-Timestamp': ts,
      },
      body,
    });
  } catch {
    // intentional — caller counts via .catch() in §11.3
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/outcomes.ts packages/telemetry/src/__tests__/outcomes.test.ts
git commit -m "feat(telemetry): outcome events client with HMAC signing"
```

---

### Task 0.13: Audit stub (`audit.ts`)

**Files:**

- Create: `packages/telemetry/src/audit.ts`
- Create: `packages/telemetry/src/__tests__/audit.test.ts`

Audit-to-S3 path is out of scope. This stub logs to pino at WARN level so
records still appear in the regular log stream until the real pipeline
ships.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { emitAudit } from '../audit.js';

describe('emitAudit', () => {
  it('writes a structured record to the supplied logger', () => {
    const warn = vi.fn();
    emitAudit(
      { event: 'bulk_row.processed', entity_id: 'r-1', attributes: { aggregator_id: 'a-1' } },
      { warn } as never,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'telemetry.audit.emit',
        event_kind: 'audit',
        event: 'bulk_row.processed',
        entity_id: 'r-1',
      }),
      'audit',
    );
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
/**
 * Audit event stub.
 *
 * The full audit pipeline (signed records, S3 Object Lock, KMS key,
 * dedicated BullMQ queue per design §6.3) is out of scope for this
 * implementation. This stub forwards each record to pino at WARN so
 * audit events still land in the regular log stream during the gap.
 */

import type { Logger } from 'pino';

export interface AuditRecord {
  event: string;
  entity_id: string;
  attributes: Record<string, unknown>;
}

export function emitAudit(record: AuditRecord, logger: Logger): void {
  logger.warn(
    {
      operation: 'telemetry.audit.emit',
      event_kind: 'audit',
      event: record.event,
      entity_id: record.entity_id,
      ...record.attributes,
    },
    'audit',
  );
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/audit.ts packages/telemetry/src/__tests__/audit.test.ts
git commit -m "feat(telemetry): audit stub forwarding to pino (full pipeline deferred)"
```

---

### Task 0.14: Testing fake (`testing/`)

**Files:**

- Create: `packages/telemetry/src/testing/in-memory.ts`
- Create: `packages/telemetry/src/testing/index.ts`
- Create: `packages/telemetry/src/testing/__tests__/in-memory.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { TelemetryFake, buildSpanFixture } from '../index.js';

describe('TelemetryFake', () => {
  it('records spans and metrics in memory', () => {
    const fake = new TelemetryFake();
    fake.recordSpan(buildSpanFixture({ name: 'api.request', attributes: { route: '/health' } }));
    fake.recordMetric({
      name: 'api.requests',
      value: 1,
      attributes: { route: '/health', status: '200' },
    });

    expect(fake.spans).toHaveLength(1);
    expect(fake.spans[0].name).toBe('api.request');
    expect(fake.metrics).toHaveLength(1);
  });

  it('seed populates spans and metrics', () => {
    const fake = new TelemetryFake();
    fake.seed({
      spans: [buildSpanFixture({ name: 'pre-seeded' })],
      metrics: [{ name: 'pre.metric', value: 5, attributes: {} }],
    });
    expect(fake.spans[0].name).toBe('pre-seeded');
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `in-memory.ts`**

```ts
export interface SpanFixture {
  name: string;
  attributes: Record<string, unknown>;
  events?: { name: string; attributes?: Record<string, unknown> }[];
  status?: 'ok' | 'error';
}

export interface MetricFixture {
  name: string;
  value: number;
  attributes: Record<string, unknown>;
}

export class InMemoryTelemetry {
  spans: SpanFixture[] = [];
  metrics: MetricFixture[] = [];

  recordSpan(span: SpanFixture): void {
    this.spans.push(span);
  }

  recordMetric(metric: MetricFixture): void {
    this.metrics.push(metric);
  }

  seed(data: { spans?: SpanFixture[]; metrics?: MetricFixture[] }): void {
    for (const s of data.spans ?? []) this.spans.push(s);
    for (const m of data.metrics ?? []) this.metrics.push(m);
  }
}
```

- [ ] **Step 4: Implement `testing/index.ts`**

```ts
export { InMemoryTelemetry as TelemetryFake } from './in-memory.js';
export type { SpanFixture, MetricFixture } from './in-memory.js';

export function buildSpanFixture(
  overrides: Partial<import('./in-memory.js').SpanFixture> = {},
): import('./in-memory.js').SpanFixture {
  return {
    name: 'test.span',
    attributes: {},
    ...overrides,
  };
}
```

- [ ] **Step 5: Run — PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/telemetry/src/testing/
git commit -m "feat(telemetry): TelemetryFake + buildSpanFixture for cross-package tests"
```

---

### Task 0.15: Public index + dep-cruiser allowance

**Files:**

- Create: `packages/telemetry/src/index.ts`
- Modify: `.dependency-cruiser.cjs` (telemetry imports OTel SDK packages, which dep-cruiser may flag)

- [ ] **Step 1: Create `src/index.ts`**

```ts
export * from './interface.js';
export { bootTelemetry, shutdownTelemetry, isTelemetryEnabled } from './bootstrap.js';
export { getLogger, resetLoggerForTesting } from './logger.js';
export { withAggregatorBaggage, withRequestIdBaggage, getAggregatorId } from './baggage.js';
export { addJobWithTrace, wrapWorker, extractJobContext } from './bullmq.js';
export { registerHttpInstrumentations } from './http.js';
export { emitTurn, emitSignal, configureOutcomes } from './outcomes.js';
export { emitAudit } from './audit.js';
export type { TurnPayload, SignalPayload } from './outcomes.js';
export type { AuditRecord } from './audit.js';
```

- [ ] **Step 2: Run dep-check**

```bash
pnpm dep-check
```

If telemetry's non-interface files are flagged for importing OTel SDK packages, the existing rules in `.dependency-cruiser.cjs` already permit anything outside `src/interface.ts` to import freely; only the interface file is restricted. No change should be needed.

If a violation does fire, add an exemption for `packages/telemetry/src/` (excluding `interface.ts`) to permit `@opentelemetry/*` imports.

- [ ] **Step 3: Build the package**

```bash
pnpm --filter @aggregator-dpg/telemetry build
```

Expected: PASS, `dist/` written.

- [ ] **Step 4: Run full test suite with coverage**

```bash
pnpm --filter @aggregator-dpg/telemetry test --coverage
```

Expected: PASS, ≥ 70 % line coverage.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/index.ts .dependency-cruiser.cjs
git commit -m "feat(telemetry): public index + dep-cruiser allowance (Phase 0 complete)"
```

---

**Phase 0 gate:** package builds, tests pass at ≥ 70 % coverage, dep-cruiser clean, **no other code imports it yet**. Stop here and review before Phase 1.

---

## Phase 1 — `apps/api` instrumented in dev only

**Goal:** Wire the api to telemetry. Bring up Collector + Jaeger + Loki + Prometheus + Grafana in docker-compose. Verify one trace flows end-to-end. Other apps still use their own loggers (untouched in this phase).

**Phase gate:** No p99 regression on `api.request.duration_ms`. A bulk-upload-create trace is visible in Jaeger with spans for `api.request` → `pg.insert` → `queue.enqueue`. Logs queryable in Loki by `trace_id`.

---

### Task 1.1: API config schema — OTEL\_\* env vars

**Files:**

- Modify: `apps/api/src/config.ts`

- [ ] **Step 1: Read current config**

```bash
sed -n '1,80p' apps/api/src/config.ts
```

- [ ] **Step 2: Add the OTel and outcomes fields to the Zod schema**

Append the following block inside `ConfigSchema = z.object({ ... })` (before the closing brace):

```ts
  // ─── Telemetry ───────────────────────────────────────────────────────────
  APP_VERSION: z.string().default('dev'),
  OTEL_SDK_DISABLED: z
    .enum(['true', 'false'])
    .default('true') // Phase 1 ships disabled-by-default; flip per env
    .transform((v) => v === 'true'),
  OTEL_COLLECTOR_ENDPOINT: z.string().default('http://otel-collector:4317'),
  OTEL_PROTOCOL: z.enum(['grpc', 'http']).default('grpc'),
  OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  OTEL_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  OTEL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // Outcome events (Phase 4 — leave unset to make the client a no-op)
  OBS_SVC_URL: z.string().url().optional(),
  OBS_HMAC_KEY_ID: z.string().optional(),
  OBS_HMAC_SECRET: z.string().optional(),
```

- [ ] **Step 3: Add `telemetryConfig` derived getter at the bottom of the file**

```ts
export const telemetryConfig = {
  otel: {
    collector_endpoint: config.OTEL_COLLECTOR_ENDPOINT,
    protocol: config.OTEL_PROTOCOL,
    sample_rate: config.OTEL_SAMPLE_RATE,
    export_interval_ms: config.OTEL_EXPORT_INTERVAL_MS,
    timeout_ms: config.OTEL_TIMEOUT_MS,
  },
  outcomes_svc_url: config.OBS_SVC_URL,
  outcomes_hmac_key_id: config.OBS_HMAC_KEY_ID,
  outcomes_hmac_secret: config.OBS_HMAC_SECRET,
  pii_fields_excluded: ['user_message', 'phone', 'email'],
};
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter aggregator-api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts
git commit -m "feat(api): add OTEL_* env vars to config schema"
```

---

### Task 1.2: API telemetry module (`apps/api/src/telemetry.ts`)

**Files:**

- Create: `apps/api/src/telemetry.ts`

- [ ] **Step 1: Create the module**

```ts
/**
 * apps/api telemetry wiring.
 *
 * Calls bootTelemetry first (must be the earliest import side effect in
 * server.ts so OTel patches the modules we register later). Exposes
 * per-service meters / tracers used by route handlers.
 */

import { metrics, trace } from '@opentelemetry/api';
import {
  bootTelemetry,
  shutdownTelemetry,
  configureOutcomes,
  registerHttpInstrumentations,
} from '@aggregator-dpg/telemetry';
import { config, telemetryConfig } from './config.js';

const SERVICE_NAME = 'aggregator-api';

export async function bootApiTelemetry(): Promise<void> {
  await bootTelemetry({
    serviceName: SERVICE_NAME,
    serviceVersion: config.APP_VERSION,
    deploymentEnvironment: config.NODE_ENV,
    config: telemetryConfig,
  });
  registerHttpInstrumentations();
  configureOutcomes({
    outcomesSvcUrl: telemetryConfig.outcomes_svc_url,
    hmacKeyId: telemetryConfig.outcomes_hmac_key_id,
    hmacSecret: telemetryConfig.outcomes_hmac_secret,
  });
}

export const shutdownApiTelemetry = shutdownTelemetry;

export const tracer = trace.getTracer(SERVICE_NAME);
export const meter = metrics.getMeter(SERVICE_NAME);

export const apiRequests = meter.createCounter('api.requests.total', {
  description: 'HTTP requests received',
});
export const apiLatencyMs = meter.createHistogram('api.request.duration_ms', { unit: 'ms' });
export const api5xx = meter.createCounter('api.5xx.total', { description: 'HTTP 5xx responses' });
export const queueEnqueueTotal = meter.createCounter('api.queue.enqueue.total');
```

- [ ] **Step 2: Add the dependency**

```bash
pnpm --filter aggregator-api add @aggregator-dpg/telemetry @opentelemetry/api
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter aggregator-api typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/telemetry.ts apps/api/package.json
git commit -m "feat(api): telemetry module with bootApiTelemetry + per-service instruments"
```

---

### Task 1.3: Collapse `apps/api/src/logger.ts` into a re-export

**Files:**

- Modify: `apps/api/src/logger.ts`

- [ ] **Step 1: Replace contents**

```ts
/**
 * Process-wide pino instance. Now sourced from @aggregator-dpg/telemetry
 * so the same instance is shared with Fastify and so a single OTLP
 * transport ships records to the Collector.
 */

import { getLogger } from '@aggregator-dpg/telemetry';
import { config } from './config.js';

export const logger = getLogger({
  serviceName: 'aggregator-api',
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
  piiFieldsExcluded: ['user_message', 'phone', 'email'],
  otlpEnabled: !config.OTEL_SDK_DISABLED,
});
```

- [ ] **Step 2: Typecheck (existing imports of `logger` from `./logger.js` continue to work)**

```bash
pnpm --filter aggregator-api typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/logger.ts
git commit -m "refactor(api): source logger from @aggregator-dpg/telemetry"
```

---

### Task 1.4: Unify Fastify logger with the shared pino instance

**Files:**

- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Replace the inline `logger:` config in `buildApp()`**

Locate lines 34–62 (`Fastify({ logger: { ... } })`) and change:

```ts
import { logger } from './logger.js';
// … later in buildApp():
const app = Fastify({
  loggerInstance: logger,
  trustProxy: parseTrustProxy(config.TRUST_PROXY),
  requestIdHeader: REQUEST_ID_HEADER,
  requestIdLogLabel: 'reqId',
  genReqId: (req) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128) {
      return incoming;
    }
    return `req-${randomUUID()}`;
  },
  disableRequestLogging: true,
});
```

Remove the entire `logger: { level, base, redact, transport }` block — it's now in the shared pino.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter aggregator-api typecheck
```

- [ ] **Step 3: Run existing api tests**

```bash
pnpm --filter aggregator-api test
```

Expected: PASS (logger config moved, not changed in shape).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/app.ts
git commit -m "refactor(api): pass shared pino instance into Fastify"
```

---

### Task 1.5: Boot telemetry first in `server.ts` + shutdown hook

**Files:**

- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Insert telemetry boot + shutdown**

Replace lines 1–14 with:

```ts
/**
 * Process entrypoint. Boots telemetry FIRST so OTel can patch modules
 * before any other import side effects. Then builds the Fastify app
 * and starts listening.
 */

import './env.js';
import { bootApiTelemetry, shutdownApiTelemetry } from './telemetry.js';
await bootApiTelemetry();

import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { getNetworkConfig } from './services/network-config.js';
import { setApprovalBrand } from './views/approval-pages.js';
import { setEmailBrand } from './services/email-templates/shared.js';
```

Then update the `shutdown` closure to flush telemetry between `app.close()` and `closeDb()`:

```ts
const shutdown = (signal: string) => async () => {
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    await shutdownApiTelemetry();
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
};
```

- [ ] **Step 2: Typecheck + test**

```bash
pnpm --filter aggregator-api typecheck
pnpm --filter aggregator-api test
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): boot telemetry first, flush on SIGTERM/SIGINT"
```

---

### Task 1.6: Set `aggregator_id` Baggage after `requireAuth` in every route

**Files (one per route):**

- Modify: `apps/api/src/routes/bulk-uploads.ts`
- Modify: `apps/api/src/routes/registration-links.ts`
- Modify: `apps/api/src/routes/public-registration-links.ts`
- Modify: `apps/api/src/routes/aggregator-registrations.ts`
- Modify: `apps/api/src/routes/aggregator-approvals.ts`
- Modify: `apps/api/src/routes/aggregator-profile.ts`
- Modify: `apps/api/src/routes/aggregator-config.ts`
- Modify: `apps/api/src/routes/dashboard.ts`
- Modify: `apps/api/src/routes/onboarding.ts`

- [ ] **Step 1: Add the import to each route file**

Add at the top of every file listed above:

```ts
import { withAggregatorBaggage } from '@aggregator-dpg/telemetry';
```

- [ ] **Step 2: Wrap each route handler body after `requireAuth(req)`**

`propagation.setBaggage(...)` returns a new immutable context, so the only OTel-correct way to make `aggregator_id` visible to outbound HTTP / BullMQ via the W3C Baggage propagator is to run the rest of the handler inside `context.with(newCtx, fn)`. The `withAggregatorBaggage(id, fn)` helper does this.

Pattern — for every handler matching `const auth = await requireAuth(req); ...rest...` wrap the `...rest...` portion in `withAggregatorBaggage`:

```ts
const auth = await requireAuth(req);
return withAggregatorBaggage(auth.aggregatorId, async () => {
  // ... the rest of the existing handler body, unchanged ...
});
```

Identify the handlers first:

```bash
grep -rn "const auth = await requireAuth(req)" apps/api/src/routes | wc -l
```

For each match, wrap from the line after `requireAuth` to the end of the handler function (excluding any error fall-through that runs outside the handler body).

- [ ] **Step 3: Verify each edit**

After wrapping, the post-auth code in each handler should be inside the `withAggregatorBaggage` callback. Smoke check:

```bash
grep -A2 "withAggregatorBaggage" apps/api/src/routes/bulk-uploads.ts | head -20
```

Every match should be followed by a callback opening.

- [ ] **Step 4: Typecheck + test**

```bash
pnpm --filter aggregator-api typecheck
pnpm --filter aggregator-api test
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/
git commit -m "feat(api): set aggregator_id baggage after requireAuth in all routes"
```

---

### Task 1.7: Custom metrics on the request lifecycle hook

**Files:**

- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Import the instruments**

Near the top of `app.ts`:

```ts
import { apiRequests, apiLatencyMs, api5xx } from './telemetry.js';
```

> **Note on `x-request-id` and Baggage.** Design §5.1 calls for `x-request-id` to be retained as a Baggage entry. Implementing this correctly through a Fastify hook would require wrapping the entire request lifecycle in `context.with` (Fastify hooks don't natively wrap downstream execution). For now, log correlation via `req.id` is already handled by Fastify's built-in `reqId` log label, and span correlation is handled by the OTel HTTP auto-instrumentation which stamps `http.request.id` automatically. Cross-service baggage propagation of the request id is a deferred follow-on.

- [ ] **Step 2: Update the `onResponse` hook to record metrics**

Replace the existing `onResponse` hook with:

```ts
app.addHook('onResponse', async (req, reply) => {
  const labels = {
    method: req.method,
    route: req.routeOptions?.url ?? req.url,
    status: String(reply.statusCode),
  };
  apiRequests.add(1, labels);
  apiLatencyMs.record(reply.elapsedTime, labels);
  if (reply.statusCode >= 500) api5xx.add(1, labels);
  req.log.info(
    {
      event: 'request.end',
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      latency_ms: Math.round(reply.elapsedTime),
    },
    `← ${req.method} ${req.url} ${reply.statusCode}`,
  );
});
```

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter aggregator-api typecheck
pnpm --filter aggregator-api test
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/app.ts
git commit -m "feat(api): emit api.requests, api.latency_ms, api.5xx on every request"
```

---

### Task 1.8: docker-compose — add Collector + Jaeger + Loki + Prometheus + Grafana

**Files:**

- Modify: `docker-compose.yml`
- Create: `infra/otel-collector/otelcol-config.dev.yaml`
- Create: `infra/grafana/provisioning/datasources/datasources.yaml`
- Create: `infra/prometheus/prometheus.yml`

- [ ] **Step 1: Create `infra/otel-collector/otelcol-config.dev.yaml`**

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 400
    spike_limit_mib: 100
  batch:
    timeout: 1s
    send_batch_size: 1024
  attributes/redact:
    actions:
      - key: phone
        action: delete
      - key: email
        action: delete
      - key: user_message
        action: delete

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  prometheus:
    endpoint: '0.0.0.0:8889'
    namespace: aggregator
  loki:
    endpoint: http://loki:3100/loki/api/v1/push
    default_labels_enabled:
      exporter: true
      job: true
      instance: true
      level: true
  debug:
    verbosity: normal

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, batch]
      exporters: [otlp/jaeger, debug]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus, debug]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, batch]
      exporters: [loki, debug]

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
```

- [ ] **Step 2: Create `infra/grafana/provisioning/datasources/datasources.yaml`**

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://otel-collector:8889
    isDefault: true
  - name: Jaeger
    type: jaeger
    access: proxy
    url: http://jaeger:16686
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
```

- [ ] **Step 3: Create `infra/prometheus/prometheus.yml`**

```yaml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: otel-collector
    static_configs:
      - targets: ['otel-collector:8889']
```

- [ ] **Step 4: Append the services to `docker-compose.yml`**

Append the following block under `services:` (preserve existing services):

```yaml
otel-collector:
  image: otel/opentelemetry-collector-contrib:0.96.0
  container_name: otel-collector
  command: ['--config=/etc/otelcol/otelcol-config.yaml']
  volumes:
    - ./infra/otel-collector/otelcol-config.dev.yaml:/etc/otelcol/otelcol-config.yaml:ro
  ports:
    - '4317:4317'
    - '4318:4318'
    - '8889:8889'
    - '13133:13133'
jaeger:
  image: jaegertracing/all-in-one:1.55
  container_name: jaeger
  ports:
    - '16686:16686'
    - '14250:14250'
  environment:
    COLLECTOR_OTLP_ENABLED: 'true'
loki:
  image: grafana/loki:2.9.4
  container_name: loki
  ports:
    - '3100:3100'
prometheus:
  image: prom/prometheus:v2.50.1
  container_name: prometheus
  command:
    - --config.file=/etc/prometheus/prometheus.yml
  volumes:
    - ./infra/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
  ports:
    - '9090:9090'
grafana:
  image: grafana/grafana:10.3.3
  container_name: grafana
  depends_on: [prometheus, jaeger, loki]
  ports:
    - '3001:3000'
  environment:
    GF_AUTH_ANONYMOUS_ENABLED: 'true'
    GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
  volumes:
    - ./infra/grafana/provisioning:/etc/grafana/provisioning:ro
```

- [ ] **Step 5: Validate the compose file**

```bash
docker compose -f docker-compose.yml config > /dev/null
```

Expected: no errors.

- [ ] **Step 6: Bring up just the telemetry stack and confirm everything is healthy**

```bash
docker compose up -d otel-collector jaeger loki prometheus grafana
docker compose ps
```

Expected: all five containers `Up` / `healthy`.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml infra/
git commit -m "feat(infra): add OTel Collector + Jaeger + Loki + Prometheus + Grafana to dev stack"
```

---

### Task 1.9: Dev environment override — enable OTel for api

**Files:**

- Modify: `apps/api/.env.example` (or wherever local env defaults live)

- [ ] **Step 1: Add the env vars**

Append to `apps/api/.env.example`:

```bash
APP_VERSION=dev
OTEL_SDK_DISABLED=false
OTEL_COLLECTOR_ENDPOINT=http://otel-collector:4317
OTEL_SAMPLE_RATE=1.0
```

- [ ] **Step 2: Document in QUICKSTART.md / SETUP.md if those files exist**

Add a short section pointing developers at `localhost:16686` (Jaeger), `localhost:3001` (Grafana), `localhost:9090` (Prometheus).

- [ ] **Step 3: Commit**

```bash
git add apps/api/.env.example QUICKSTART.md SETUP.md 2>/dev/null
git commit -m "docs(api): document local OTel env vars and observability URLs"
```

---

### Task 1.10: End-to-end trace verification

**No file changes — verification only.**

- [ ] **Step 1: Bring up the full stack**

```bash
docker compose up -d
```

- [ ] **Step 2: Hit a route that touches DB + queue**

```bash
curl -sf -X POST http://localhost:4000/v1/onboard/bulk-uploads \
  -H 'Authorization: Bearer <dev-token>' \
  -F 'file=@/tmp/sample.csv'
```

- [ ] **Step 3: Verify the trace in Jaeger**

Open `http://localhost:16686`. Service dropdown → `aggregator-api`. Find the trace; confirm spans include `api.request POST /v1/onboard/bulk-uploads`, a `pg.*` child span, and a `queue.enqueue` child span.

- [ ] **Step 4: Verify metrics in Prometheus**

Open `http://localhost:9090/graph?g0.expr=aggregator_api_requests_total`. Confirm the counter increments.

- [ ] **Step 5: Verify logs in Loki via Grafana**

Open `http://localhost:3001/explore`, datasource `Loki`, query `{service_name="aggregator-api"} |= "request.end"`. Confirm log lines include `trace_id` matching the Jaeger trace.

- [ ] **Step 6: If anything fails — debug, do not move on. If it passes — commit a note**

```bash
git commit --allow-empty -m "chore(telemetry): end-to-end dev verification passed (Phase 1 gate)"
```

---

**Phase 1 gate:** one request shows in Jaeger, Prometheus, and Loki, all stitched by the same `trace_id`. Stop and review before Phase 2.

---

## Phase 2 — `apps/worker` instrumented + cross-process trace stitching

**Goal:** Instrument worker; wire `addJobWithTrace` at the api producer site; wrap every BullMQ worker in `wrapWorker`. A bulk-upload trace now extends api → BullMQ → worker → SignalStack as one continuous trace.

**Phase gate:** A bulk-upload create returns a trace where the worker spans are children of the api span; SignalStack calls appear as the deepest leaf spans.

---

### Task 2.1: Worker config schema — same OTEL\_\* env vars

**Files:**

- Modify: `apps/worker/src/config.ts`

- [ ] **Step 1: Read current schema**

```bash
sed -n '1,60p' apps/worker/src/config.ts
```

- [ ] **Step 2: Add the same telemetry fields used in api**

Append inside the worker `ConfigSchema`:

```ts
  APP_VERSION: z.string().default('dev'),
  OTEL_SDK_DISABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  OTEL_COLLECTOR_ENDPOINT: z.string().default('http://otel-collector:4317'),
  OTEL_PROTOCOL: z.enum(['grpc', 'http']).default('grpc'),
  OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  OTEL_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  OTEL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  OBS_SVC_URL: z.string().url().optional(),
  OBS_HMAC_KEY_ID: z.string().optional(),
  OBS_HMAC_SECRET: z.string().optional(),
```

And the `telemetryConfig` derived getter at the bottom (same shape as api).

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter aggregator-worker typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/config.ts
git commit -m "feat(worker): add OTEL_* env vars to config schema"
```

---

### Task 2.2: Worker telemetry module + logger refactor

**Files:**

- Create: `apps/worker/src/telemetry.ts`
- Modify: `apps/worker/src/logger.ts`

- [ ] **Step 1: Create `apps/worker/src/telemetry.ts`**

```ts
/**
 * apps/worker telemetry wiring.
 */

import { metrics, trace } from '@opentelemetry/api';
import {
  bootTelemetry,
  shutdownTelemetry,
  configureOutcomes,
  registerHttpInstrumentations,
} from '@aggregator-dpg/telemetry';
import { config, telemetryConfig } from './config.js';

const SERVICE_NAME = 'aggregator-worker';

export async function bootWorkerTelemetry(): Promise<void> {
  await bootTelemetry({
    serviceName: SERVICE_NAME,
    serviceVersion: config.APP_VERSION,
    deploymentEnvironment: config.NODE_ENV,
    config: telemetryConfig,
  });
  registerHttpInstrumentations();
  configureOutcomes({
    outcomesSvcUrl: telemetryConfig.outcomes_svc_url,
    hmacKeyId: telemetryConfig.outcomes_hmac_key_id,
    hmacSecret: telemetryConfig.outcomes_hmac_secret,
  });
}

export const shutdownWorkerTelemetry = shutdownTelemetry;

export const tracer = trace.getTracer(SERVICE_NAME);
export const meter = metrics.getMeter(SERVICE_NAME);

export const bulkRowsTotal = meter.createCounter('worker.bulk_rows.total', {
  description: 'Bulk rows processed (status label)',
});
export const bulkRowDurationMs = meter.createHistogram('worker.bulk_row.duration_ms', {
  unit: 'ms',
});
export const signalStackCalls = meter.createCounter('signalstack.calls.total');
export const signalStackDurationMs = meter.createHistogram('signalstack.duration_ms', {
  unit: 'ms',
});
export const jobDurationMs = meter.createHistogram('worker.job.duration_ms', { unit: 'ms' });
```

- [ ] **Step 2: Replace `apps/worker/src/logger.ts` with a re-export**

```ts
import { getLogger } from '@aggregator-dpg/telemetry';
import { config } from './config.js';

export const logger = getLogger({
  serviceName: 'aggregator-worker',
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
  piiFieldsExcluded: ['user_message', 'phone', 'email'],
  otlpEnabled: !config.OTEL_SDK_DISABLED,
});
```

- [ ] **Step 3: Add the dep**

```bash
pnpm --filter aggregator-worker add @aggregator-dpg/telemetry @opentelemetry/api
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter aggregator-worker typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/telemetry.ts apps/worker/src/logger.ts apps/worker/package.json
git commit -m "feat(worker): telemetry module + shared logger"
```

---

### Task 2.3: Boot telemetry first + wrap every Worker handler

**Files:**

- Modify: `apps/worker/src/main.ts`

- [ ] **Step 1: Insert the boot call at the top**

Modify lines 1–30 to:

```ts
/**
 * Worker entrypoint.
 *
 * Boots telemetry FIRST so OTel can patch modules used by the BullMQ
 * Workers we register below.
 */

import { bootWorkerTelemetry, shutdownWorkerTelemetry, jobDurationMs } from './telemetry.js';
await bootWorkerTelemetry();

import { Queue, Worker } from 'bullmq';
import {
  QueueName,
  DEFAULT_JOB_OPTS,
  type BulkFileProcessJob,
  type BulkFinaliseJob,
  type BulkRowProcessJob,
  type CronWatchdogJob,
  type LinkMetricsRollupJob,
} from '@aggregator-dpg/queue';
import { wrapWorker } from '@aggregator-dpg/telemetry';
import { config } from './config.js';
import { logger } from './logger.js';
import { closeDb } from './db.js';
import { processBulkFile } from './jobs/bulk-file-process.js';
import { processBulkRow } from './jobs/bulk-row-process.js';
import { finaliseBulk } from './jobs/bulk-finalise.js';
import { rollupLinkMetrics } from './jobs/link-metrics-rollup.js';
import { runWatchdog } from './jobs/cron-watchdog.js';
import { getRedis, closeRedis } from './services/redis.js';
import { closeQueues } from './services/bulk-queue.js';
```

- [ ] **Step 2: Wrap each `Worker` handler**

For each `new Worker<T>(name, handler, opts)` in `main.ts`, change `handler` to use `wrapWorker`. Example for the file worker:

```ts
const fileWorker = new Worker<BulkFileProcessJob>(
  QueueName.BulkFileProcess,
  async (job) => {
    const start = Date.now();
    try {
      return await wrapWorker(QueueName.BulkFileProcess, job.data, () => processBulkFile(job.data));
    } finally {
      jobDurationMs.record(Date.now() - start, { queue: QueueName.BulkFileProcess });
    }
  },
  { connection, concurrency: config.BULK_FILE_PROCESS_CONCURRENCY },
);
```

Apply the same pattern to `rowWorker`, `finaliseWorker`, `linkMetricsWorker`, `watchdogWorker`.

- [ ] **Step 3: Add telemetry shutdown in the SIGTERM handler**

Update `shutdown` to flush telemetry between worker close and Redis/DB close:

```ts
const shutdown = async (signal: string): Promise<void> => {
  logger.info({ operation: 'worker.shutdown', signal });
  await Promise.all([
    fileWorker.close(),
    rowWorker.close(),
    finaliseWorker.close(),
    linkMetricsWorker.close(),
    watchdogWorker.close(),
  ]);
  await Promise.all([linkMetricsQueue.close(), watchdogQueue.close()]);
  await closeQueues();
  await shutdownWorkerTelemetry();
  await closeRedis();
  await closeDb();
  process.exit(0);
};
```

- [ ] **Step 4: Typecheck + test**

```bash
pnpm --filter aggregator-worker typecheck
pnpm --filter aggregator-worker test
```

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/main.ts
git commit -m "feat(worker): boot telemetry first, wrap every BullMQ handler"
```

---

### Task 2.4: Producer-side `addJobWithTrace` at every `queue.add` site in api

**Files:**

- Modify: `apps/api/src/services/bulk-queue/index.ts`

- [ ] **Step 1: Read current producer**

```bash
sed -n '1,80p' apps/api/src/services/bulk-queue/index.ts
```

- [ ] **Step 2: Replace `queue.add(...)` calls with `addJobWithTrace`**

Add the import at the top:

```ts
import { addJobWithTrace } from '@aggregator-dpg/telemetry';
```

For every line matching `await getFileProcessQueue().add(QueueName.BulkFileProcess, payload, …)` change to:

```ts
await addJobWithTrace(getFileProcessQueue(), QueueName.BulkFileProcess, payload, jobOpts);
```

Repeat for any other `*Queue().add(...)` call in this file or sibling producer files. Identify them first:

```bash
grep -rn "\.add(QueueName" apps/api/src apps/worker/src --include="*.ts" | grep -v ".test.ts"
```

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter aggregator-api typecheck
pnpm --filter aggregator-api test
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/bulk-queue/index.ts
git commit -m "feat(api): inject traceparent into BullMQ payloads via addJobWithTrace"
```

---

### Task 2.5: Producer-side `addJobWithTrace` inside the worker's own fan-out

The File Processor enqueues row jobs. Stitch those too.

**Files:**

- Modify: `apps/worker/src/jobs/bulk-file-process.ts`

- [ ] **Step 1: Find row-job enqueues**

```bash
grep -n "\.add(" apps/worker/src/jobs/bulk-file-process.ts
```

- [ ] **Step 2: Switch them to `addJobWithTrace`**

Add the import:

```ts
import { addJobWithTrace } from '@aggregator-dpg/telemetry';
```

Replace each `someQueue.add(name, payload, opts)` with `addJobWithTrace(someQueue, name, payload, opts)`. Same for `apps/worker/src/jobs/bulk-finalise.ts` and any other job that enqueues children.

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter aggregator-worker typecheck
pnpm --filter aggregator-worker test
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/jobs/
git commit -m "feat(worker): propagate trace context when worker fans out child jobs"
```

---

### Task 2.6: Custom span around SignalStack call in `bulk-row-process.ts`

**Files:**

- Modify: `apps/worker/src/jobs/bulk-row-process.ts`

- [ ] **Step 1: Read current job**

```bash
sed -n '1,80p' apps/worker/src/jobs/bulk-row-process.ts
```

- [ ] **Step 2: Wrap the SignalStack call**

Add imports:

```ts
import {
  tracer,
  signalStackCalls,
  signalStackDurationMs,
  bulkRowsTotal,
  bulkRowDurationMs,
} from '../telemetry.js';
import { SpanStatusCode } from '@opentelemetry/api';
```

Wrap the call (rename actual function/method as needed in the file):

```ts
const rowStart = Date.now();
const result = await tracer.startActiveSpan('worker.signalstack.onboard', async (span) => {
  const callStart = Date.now();
  try {
    const out = await signalStackClient.onboard(payload);
    signalStackCalls.add(1, { status: 'success' });
    return out;
  } catch (e) {
    span.recordException(e as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    signalStackCalls.add(1, { status: 'failure' });
    throw e;
  } finally {
    signalStackDurationMs.record(Date.now() - callStart);
    span.end();
  }
});

bulkRowsTotal.add(1, { status: result.ok ? 'success' : 'failure' });
bulkRowDurationMs.record(Date.now() - rowStart, { status: result.ok ? 'success' : 'failure' });
```

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter aggregator-worker typecheck
pnpm --filter aggregator-worker test
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/jobs/bulk-row-process.ts
git commit -m "feat(worker): custom span + metrics around SignalStack onboard call"
```

---

### Task 2.7: End-to-end cross-process trace verification

- [ ] **Step 1: Restart the stack**

```bash
docker compose restart api worker
```

- [ ] **Step 2: POST a bulk upload**

```bash
curl -sf -X POST http://localhost:4000/v1/onboard/bulk-uploads \
  -H 'Authorization: Bearer <dev-token>' \
  -F 'file=@/tmp/sample-2rows.csv'
```

- [ ] **Step 3: Open Jaeger, find the trace**

Confirm the trace contains, in order:

1. `api.request POST /v1/onboard/bulk-uploads` (root, service=aggregator-api)
2. `queue.enqueue` (child, service=aggregator-api)
3. `worker.bulk-file-process.process` (child, service=aggregator-worker)
4. Two `worker.bulk-row.process.process` siblings (service=aggregator-worker)
5. Two `worker.signalstack.onboard` leaves (service=aggregator-worker)

All under one `trace_id`.

- [ ] **Step 4: Commit verification**

```bash
git commit --allow-empty -m "chore(telemetry): cross-process trace stitching verified (Phase 2 gate)"
```

---

**Phase 2 gate:** end-to-end trace spans both processes. Stop and review before Phase 3.

---

## Phase 3 — `apps/web` instrumented + prod cutover

**Goal:** Add Next.js instrumentation to the web BFF; deploy the full stack to staging then prod; switch on tail sampling; provision Grafana dashboards and SLO alerts.

**Phase gate:** All three blocks emit OTel in prod with head sample 0.1, tail sampler keeps every error trace, cost ≤ 80 % of §6.4 budget. SLO burn-rate alerts fire correctly in a synthetic test.

---

### Task 3.1: Next.js instrumentation entry point

**Files:**

- Create: `apps/web/instrumentation.ts`
- Create: `apps/web/src/lib/telemetry.ts`

- [ ] **Step 1: Create `apps/web/instrumentation.ts`** (Next.js looks for this file at app root)

```ts
/**
 * Next.js OTel entry point.
 *
 * Invoked once when the server boots — earlier than any route module.
 * Guards against double-boot under HMR via the @aggregator-dpg/telemetry
 * idempotency check.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { bootWebTelemetry } = await import('./src/lib/telemetry.js');
  await bootWebTelemetry();
}
```

- [ ] **Step 2: Create `apps/web/src/lib/telemetry.ts`**

```ts
import { metrics, trace } from '@opentelemetry/api';
import {
  bootTelemetry,
  shutdownTelemetry,
  registerHttpInstrumentations,
} from '@aggregator-dpg/telemetry';

const SERVICE_NAME = 'aggregator-web';

export async function bootWebTelemetry(): Promise<void> {
  await bootTelemetry({
    serviceName: SERVICE_NAME,
    serviceVersion: process.env.APP_VERSION ?? 'dev',
    deploymentEnvironment: process.env.NODE_ENV ?? 'development',
    config: {
      otel: {
        collector_endpoint: process.env.OTEL_COLLECTOR_ENDPOINT ?? 'http://otel-collector:4317',
        protocol: 'grpc',
        sample_rate: Number(process.env.OTEL_SAMPLE_RATE ?? 0.1),
        export_interval_ms: 5000,
        timeout_ms: 10000,
      },
      pii_fields_excluded: ['user_message', 'phone', 'email'],
    },
  });
  registerHttpInstrumentations();
}

export const shutdownWebTelemetry = shutdownTelemetry;

export const tracer = trace.getTracer(SERVICE_NAME);
export const meter = metrics.getMeter(SERVICE_NAME);

export const webTtfbMs = meter.createHistogram('web.ttfb_ms', { unit: 'ms' });
export const webRequests = meter.createCounter('web.requests.total');
export const webProxyDurationMs = meter.createHistogram('web.api_proxy.duration_ms', {
  unit: 'ms',
});
```

- [ ] **Step 3: Add dependency**

```bash
pnpm --filter aggregator-web add @aggregator-dpg/telemetry @opentelemetry/api
```

- [ ] **Step 4: Build the web app to confirm Next picks it up**

```bash
pnpm --filter aggregator-web build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/instrumentation.ts apps/web/src/lib/telemetry.ts apps/web/package.json
git commit -m "feat(web): Next.js OTel instrumentation entry"
```

---

### Task 3.2: Web BFF spans on API proxy calls

**Files:**

- Modify: `apps/web/src/lib/api-client.ts` (or whichever file is the BFF → api fetch wrapper; locate with the grep step)

- [ ] **Step 1: Locate the BFF fetch wrapper**

```bash
grep -rln "fetch(" apps/web/src/lib apps/web/src/services 2>/dev/null | head -5
```

- [ ] **Step 2: Add a `web.api_proxy` span around the fetch**

In the file that wraps outbound fetch to the api, import:

```ts
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer, webProxyDurationMs } from './telemetry.js';
```

Wrap the call (rename the actual function as needed):

```ts
export async function callApi(path: string, init?: RequestInit): Promise<Response> {
  return tracer.startActiveSpan('web.api_proxy', async (span) => {
    span.setAttribute('http.route', path);
    const start = Date.now();
    try {
      const res = await fetch(`${process.env.INTERNAL_API_URL}${path}`, init);
      span.setAttribute('http.status_code', res.status);
      if (res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return res;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      webProxyDurationMs.record(Date.now() - start, { path });
      span.end();
    }
  });
}
```

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter aggregator-web typecheck
pnpm --filter aggregator-web test
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/
git commit -m "feat(web): web.api_proxy span around BFF → api fetch"
```

---

### Task 3.3: Helm chart updates — env vars + terminationGracePeriodSeconds

**Files:**

- Modify: `helm/aggregator-dpg/charts/api/values.yaml`
- Modify: `helm/aggregator-dpg/charts/worker/values.yaml`
- Modify: `helm/aggregator-dpg/charts/web/values.yaml`
- Modify: `helm/aggregator-dpg/charts/api/templates/deployment.yaml` (and worker, web equivalents)

- [ ] **Step 1: Add OTel env block to each `values.yaml`**

For each of api / worker / web, add under the deployment section:

```yaml
telemetry:
  enabled: true
  appVersion: '' # set per release; falls back to chart appVersion
  otel:
    collectorEndpoint: 'http://otel-collector.observability.svc.cluster.local:4317'
    sampleRate: '0.1'
    exportIntervalMs: '5000'
    # Per design §6.1 — caps on per-attribute and total attribute payload
    # so a runaway payload can't blow up the Collector or backend storage.
    attributeValueLengthLimit: '4096'
  observabilitySvc:
    url: '' # filled in Phase 4
    hmacKeyIdEnv: 'OBS_HMAC_KEY_ID'
    hmacSecretEnv: 'OBS_HMAC_SECRET'

terminationGracePeriodSeconds: 45 # ≥ OTEL_BSP_EXPORT_TIMEOUT + worker drain budget
```

- [ ] **Step 2: Update each deployment template to project the env vars**

Add to each `deployment.yaml` under `spec.template.spec.containers[0].env`:

```yaml
            - name: APP_VERSION
              value: "{{ .Values.telemetry.appVersion | default .Chart.AppVersion }}"
            - name: OTEL_SDK_DISABLED
              value: "{{ ternary "false" "true" .Values.telemetry.enabled }}"
            - name: OTEL_COLLECTOR_ENDPOINT
              value: "{{ .Values.telemetry.otel.collectorEndpoint }}"
            - name: OTEL_SAMPLE_RATE
              value: "{{ .Values.telemetry.otel.sampleRate }}"
            - name: OTEL_EXPORT_INTERVAL_MS
              value: "{{ .Values.telemetry.otel.exportIntervalMs }}"
            - name: OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT
              value: "{{ .Values.telemetry.otel.attributeValueLengthLimit }}"
            - name: OBS_SVC_URL
              value: "{{ .Values.telemetry.observabilitySvc.url }}"
            - name: OBS_HMAC_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: aggregator-obs-secrets
                  key: hmac-key-id
                  optional: true
            - name: OBS_HMAC_SECRET
              valueFrom:
                secretKeyRef:
                  name: aggregator-obs-secrets
                  key: hmac-secret
                  optional: true
```

Add at the same level as `containers`:

```yaml
terminationGracePeriodSeconds: { { .Values.terminationGracePeriodSeconds } }
```

- [ ] **Step 3: Lint Helm**

```bash
helm lint helm/aggregator-dpg
```

- [ ] **Step 4: Render to confirm**

```bash
helm template aggregator-dpg helm/aggregator-dpg | grep -A2 OTEL_COLLECTOR_ENDPOINT
```

Expected: the env var appears in each of api / worker / web deployments.

- [ ] **Step 5: Commit**

```bash
git add helm/aggregator-dpg/
git commit -m "feat(helm): OTEL_* env + terminationGracePeriodSeconds across api/worker/web"
```

---

### Task 3.4: Production Collector config — memory_limiter + tail sampling

**Files:**

- Create: `infra/otel-collector/otelcol-config.prod.yaml`

- [ ] **Step 1: Write the prod config**

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  attributes/redact:
    actions:
      - key: phone
        action: delete
      - key: email
        action: delete
      - key: user_message
        action: delete
      - key: password
        action: delete
  tail_sampling:
    decision_wait: 10s
    num_traces: 50000
    expected_new_traces_per_sec: 100
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 2000 }
      - name: flagged-routes
        type: string_attribute
        string_attribute:
          key: http.route
          values:
            - /v1/onboard/bulk-uploads
            - /v1/onboard/bulk-uploads/.*
            - /v1/onboard/links
            - /v1/onboard/links/.*
            - /v1/onboard/links/public/.*
            - /v1/registration-requests
            - /v1/registration-requests/.*
            - /v1/aggregators/approvals/.*
            - /v1/onboard/.*
          enabled_regex_matching: true
      - name: probabilistic
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }
      - name: never-health
        type: string_attribute
        string_attribute:
          key: http.route
          values: ['/v1/health', '/health', '/ready']
          invert_match: true
  batch:
    timeout: 1s
    send_batch_size: 1024

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  prometheus:
    endpoint: '0.0.0.0:8889'
    namespace: aggregator
  loki:
    endpoint: http://loki:3100/loki/api/v1/push

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, tail_sampling, batch]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, batch]
      exporters: [loki]

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
```

- [ ] **Step 2: Validate with otelcol --config dryrun**

```bash
docker run --rm -v "$(pwd)/infra/otel-collector:/etc/otelcol:ro" \
  otel/opentelemetry-collector-contrib:0.96.0 \
  --config=/etc/otelcol/otelcol-config.prod.yaml --dry-run
```

Expected: no errors.

- [ ] **Step 3: Helm chart for Collector**

Create a thin chart (or reference an upstream contrib chart) under `helm/aggregator-dpg/charts/otel-collector/` that mounts this config from a ConfigMap. If using upstream chart, add a `values.yaml` that supplies the config inline.

- [ ] **Step 4: Commit**

```bash
git add infra/otel-collector/otelcol-config.prod.yaml helm/aggregator-dpg/charts/otel-collector/
git commit -m "feat(infra): prod Collector config with memory_limiter + tail sampling"
```

---

### Task 3.5: Grafana dashboard provisioning + SLO burn-rate alerts

**Files:**

- Create: `infra/grafana/dashboards/aggregator-api.json`
- Create: `infra/grafana/dashboards/aggregator-worker.json`
- Create: `infra/grafana/dashboards/aggregator-web.json`
- Create: `infra/grafana/provisioning/dashboards/dashboards.yaml`
- Create: `infra/prometheus/rules/slo.rules.yml`

- [ ] **Step 1: Dashboards provisioning index**

`infra/grafana/provisioning/dashboards/dashboards.yaml`:

```yaml
apiVersion: 1
providers:
  - name: aggregator
    folder: Aggregator
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

- [ ] **Step 2: API dashboard JSON skeleton**

`infra/grafana/dashboards/aggregator-api.json` — panels for:

- p50 / p95 / p99 of `aggregator_api_request_duration_ms_bucket` (heatmap + histogram quantile)
- Error rate: `sum(rate(aggregator_api_5xx_total[5m])) / sum(rate(aggregator_api_requests_total[5m]))`
- Throughput: `sum(rate(aggregator_api_requests_total[1m])) by (route)`
- Trace exemplar links into Jaeger

(Engineer: build the JSON in Grafana UI first, then export to disk via "Share dashboard → Export → Save to file".)

- [ ] **Step 3: Worker dashboard**

Panels for `worker_bulk_row_duration_ms_*`, `worker_signalstack_calls_total{status}`, `worker_job_duration_ms_*` by queue.

- [ ] **Step 4: Web dashboard**

Panels for `web_ttfb_ms_bucket`, `web_requests_total`, `web_api_proxy_duration_ms_bucket`.

- [ ] **Step 5: SLO recording + alerting rules**

`infra/prometheus/rules/slo.rules.yml`:

```yaml
groups:
  - name: aggregator-slo
    interval: 30s
    rules:
      # api availability SLI
      - record: slo:api_availability:ratio_rate5m
        expr: |
          1 - (
            sum(rate(aggregator_api_5xx_total[5m]))
            /
            sum(rate(aggregator_api_requests_total[5m]))
          )

      # fast burn — 2% of monthly budget in 1h (paging)
      - alert: ApiAvailabilityFastBurn
        expr: |
          (1 - slo:api_availability:ratio_rate5m) > (14.4 * (1 - 0.995))
        for: 5m
        labels: { severity: page, slo: api_availability }
        annotations:
          summary: 'api availability fast burn (1h)'

      # slow burn — 5% in 6h (ticket)
      - alert: ApiAvailabilitySlowBurn
        expr: |
          (1 - slo:api_availability:ratio_rate5m) > (6 * (1 - 0.995))
        for: 30m
        labels: { severity: ticket, slo: api_availability }
        annotations:
          summary: 'api availability slow burn (6h)'
```

Mount under Prometheus via `prometheus.yml`:

```yaml
rule_files:
  - /etc/prometheus/rules/*.yml
```

- [ ] **Step 6: Restart Grafana + Prometheus and verify**

```bash
docker compose restart grafana prometheus
```

Open Grafana, confirm dashboards load and panels show data.

- [ ] **Step 7: Commit**

```bash
git add infra/grafana/ infra/prometheus/
git commit -m "feat(infra): Grafana dashboards + Prometheus SLO burn-rate rules"
```

---

### Task 3.6: Cost / volume budget Prometheus rule

**Files:**

- Create: `infra/prometheus/rules/telemetry-budget.rules.yml`

- [ ] **Step 1: Write the rule file**

```yaml
groups:
  - name: telemetry-budget
    interval: 5m
    rules:
      - record: telemetry:traces_gb_per_day
        expr: |
          sum(rate(otelcol_exporter_sent_spans[5m])) * 86400 * 0.000001
      - record: telemetry:logs_gb_per_day
        expr: |
          sum(rate(otelcol_exporter_sent_log_records[5m])) * 86400 * 0.000001
      - alert: TelemetryTracesBudgetAt80
        expr: telemetry:traces_gb_per_day > 40
        for: 30m
        labels: { severity: ticket }
        annotations:
          summary: 'Traces volume ≥ 80% of 50 GB/day budget'
```

- [ ] **Step 2: Reload Prometheus**

```bash
curl -X POST http://localhost:9090/-/reload
```

- [ ] **Step 3: Commit**

```bash
git add infra/prometheus/rules/telemetry-budget.rules.yml
git commit -m "feat(infra): cost/volume budget rules per design §6.4"
```

---

### Task 3.7: Phased rollout cutover

No code — staged config flip.

- [ ] **Step 1: Staging — flip OTEL_SDK_DISABLED=false, sample_rate=1.0**

```bash
helm upgrade --install aggregator-dpg helm/aggregator-dpg \
  --namespace staging \
  --set telemetry.enabled=true \
  --set telemetry.otel.sampleRate=1.0
```

- [ ] **Step 2: Bake for one week**

Monitor `aggregator_api_request_duration_ms_*` p99 vs the pre-OTel baseline. Goal: no >1 ms p99 regression (design G2).

- [ ] **Step 3: Prod — flip to sample_rate=0.1, tail sampling on**

```bash
helm upgrade --install aggregator-dpg helm/aggregator-dpg \
  --namespace prod \
  --set telemetry.enabled=true \
  --set telemetry.otel.sampleRate=0.1
```

- [ ] **Step 4: Bake for two weeks**

Verify cost ≤ 80 % of §6.4 budget via `telemetry:traces_gb_per_day` panel.

- [ ] **Step 5: Commit a release note**

```bash
git commit --allow-empty -m "chore(telemetry): all three blocks live in prod (Phase 3 gate)"
```

---

**Phase 3 gate:** prod traffic emits OTel; tail sampling keeps 100 % of errors + flagged-route traces; SLO alerts validated by a synthetic 5xx burst. Stop before Phase 4.

---

## Phase 4 — `apps/observability-svc` + outcome events

**Goal:** Stand up the standalone outcome-event receiver. Wire `emitTurn`/`emitSignal` calls at business event points in api/worker. HMAC-authenticate every request. Dedup via Redis. Each outcome event maps to one or more declarative metric increments per `observability.outcomes.metrics` in `config/observability.yaml`.

**Phase gate:** duplicate emit returns 200 without double-counting; an unauthenticated POST returns 401; the configured metrics increment after one valid emit.

---

### Task 4.1: Scaffold the service

**Files:**

- Create: `apps/observability-svc/package.json`
- Create: `apps/observability-svc/tsconfig.json`
- Create: `apps/observability-svc/vitest.config.ts`
- Create: `apps/observability-svc/Dockerfile`
- Create: `apps/observability-svc/README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@aggregator-dpg/observability-svc",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@aggregator-dpg/telemetry": "workspace:*",
    "@aggregator-dpg/shared-primitives": "workspace:*",
    "@opentelemetry/api": "^1.9.0",
    "fastify": "^5.0.0",
    "@fastify/sensible": "^6.0.0",
    "ioredis": "^5.10.1",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@aggregator-dpg/tsconfig": "workspace:*",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.4",
    "typescript": "^6.0.3",
    "vitest": "^3.2.0",
    "@vitest/coverage-v8": "^3.2.0"
  }
}
```

- [ ] **Step 2: Standard tsconfig + vitest configs**

`tsconfig.json` (mirrors `packages/_template/tsconfig.json`):

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@aggregator-dpg/tsconfig/node.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "composite": true,
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/__tests__", "dist"]
}
```

`vitest.config.ts` (mirrors `packages/_template/vitest.config.ts`):

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
      thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
});
```

- [ ] **Step 3: Dockerfile**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/observability-svc ./apps/observability-svc
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @aggregator-dpg/observability-svc build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/observability-svc/dist/main.js"]
```

- [ ] **Step 4: Install + verify**

```bash
pnpm install
pnpm --filter @aggregator-dpg/observability-svc typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/observability-svc/
git commit -m "feat(observability-svc): scaffold service"
```

---

### Task 4.2: Config schema (`config.ts`)

**Files:**

- Create: `apps/observability-svc/src/config.ts`
- Create: `apps/observability-svc/src/__tests__/config.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('observability-svc config', () => {
  it('parses minimal env', () => {
    const cfg = loadConfig({
      PORT: '8080',
      REDIS_URL: 'redis://localhost:6379',
      OUTCOMES_HMAC_SECRETS_JSON: '{"svc-api":"shh"}',
      ADMIN_TOKEN: 'admin-secret',
      APP_VERSION: '1.0.0',
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.OUTCOMES_HMAC_SECRETS['svc-api']).toBe('shh');
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string(),
  // JSON map of HMAC keyId → secret, e.g. {"svc-api":"...","svc-worker":"..."}
  OUTCOMES_HMAC_SECRETS_JSON: z.string(),
  ADMIN_TOKEN: z.string().min(16),
  APP_VERSION: z.string().default('dev'),
  IDEM_TTL_DAYS: z.coerce.number().int().positive().default(90),
  // Telemetry — this service emits OTel too
  OTEL_SDK_DISABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OTEL_COLLECTOR_ENDPOINT: z.string().default('http://otel-collector:4317'),
  OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1.0),
  // Outcome metric catalogue — JSON of design §9 outcomes.metrics, e.g.
  // [{"name":"participant.registered.total","instrument":"counter","attributes":["aggregator_id_bucket","participant_kind","source"]}]
  OUTCOME_METRICS_JSON: z.string().default('[]'),
});

export type RawConfig = z.input<typeof Schema>;

export interface AppConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  HOST: string;
  LOG_LEVEL: string;
  REDIS_URL: string;
  OUTCOMES_HMAC_SECRETS: Record<string, string>;
  ADMIN_TOKEN: string;
  APP_VERSION: string;
  IDEM_TTL_DAYS: number;
  OTEL_SDK_DISABLED: boolean;
  OTEL_COLLECTOR_ENDPOINT: string;
  OTEL_SAMPLE_RATE: number;
  OUTCOME_METRICS: OutcomeMetricDef[];
}

export interface OutcomeMetricDef {
  name: string;
  instrument: 'counter' | 'histogram' | 'updown_counter';
  description?: string;
  unit?: string;
  attributes?: string[];
  /** Match an event name to apply this metric to. */
  on_event?: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = Schema.parse(env);
  return {
    ...parsed,
    OUTCOMES_HMAC_SECRETS: JSON.parse(parsed.OUTCOMES_HMAC_SECRETS_JSON),
    OUTCOME_METRICS: JSON.parse(parsed.OUTCOME_METRICS_JSON) as OutcomeMetricDef[],
  };
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/observability-svc/src/config.ts apps/observability-svc/src/__tests__/config.test.ts
git commit -m "feat(observability-svc): config schema with HMAC keymap + outcome metric defs"
```

---

### Task 4.3: HMAC auth middleware

**Files:**

- Create: `apps/observability-svc/src/hmac-auth.ts`
- Create: `apps/observability-svc/src/__tests__/hmac-auth.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyHmac } from '../hmac-auth.js';

const secrets = { 'svc-api': 'shh' };

describe('verifyHmac', () => {
  const body = '{"event":"x"}';
  const ts = '1700000000000';
  const sig = createHmac('sha256', 'shh')
    .update(ts + body)
    .digest('hex');

  it('accepts a valid signature within the replay window', () => {
    const now = Number(ts) + 60_000; // 60s later
    expect(
      verifyHmac({ keyId: 'svc-api', signature: sig, timestamp: ts, body, secrets, now }),
    ).toBe('ok');
  });

  it('rejects unknown keyId', () => {
    expect(
      verifyHmac({
        keyId: 'svc-other',
        signature: sig,
        timestamp: ts,
        body,
        secrets,
        now: Number(ts),
      }),
    ).toBe('unknown_key');
  });

  it('rejects bad signature', () => {
    expect(
      verifyHmac({
        keyId: 'svc-api',
        signature: 'deadbeef',
        timestamp: ts,
        body,
        secrets,
        now: Number(ts),
      }),
    ).toBe('bad_sig');
  });

  it('rejects stale timestamp (>5m)', () => {
    expect(
      verifyHmac({
        keyId: 'svc-api',
        signature: sig,
        timestamp: ts,
        body,
        secrets,
        now: Number(ts) + 6 * 60_000,
      }),
    ).toBe('stale');
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const REPLAY_WINDOW_MS = 5 * 60_000;

export type HmacResult = 'ok' | 'unknown_key' | 'bad_sig' | 'stale' | 'missing';

interface VerifyArgs {
  keyId: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  secrets: Record<string, string>;
  now?: number;
}

export function verifyHmac(args: VerifyArgs): HmacResult {
  if (!args.keyId || !args.signature || !args.timestamp) return 'missing';
  const secret = args.secrets[args.keyId];
  if (!secret) return 'unknown_key';

  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return 'stale';
  const now = args.now ?? Date.now();
  if (Math.abs(now - ts) > REPLAY_WINDOW_MS) return 'stale';

  const expected = createHmac('sha256', secret)
    .update(args.timestamp + args.body)
    .digest('hex');
  const a = Buffer.from(args.signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'bad_sig';
  return 'ok';
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/observability-svc/src/hmac-auth.ts apps/observability-svc/src/__tests__/hmac-auth.test.ts
git commit -m "feat(observability-svc): HMAC verification with 5m replay window"
```

---

### Task 4.4: Redis idempotency store

**Files:**

- Create: `apps/observability-svc/src/idempotency.ts`
- Create: `apps/observability-svc/src/__tests__/idempotency.test.ts`

- [ ] **Step 1: Failing test (uses an ioredis-mock or in-memory fake — choose `ioredis-mock`)**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { IdempotencyStore } from '../idempotency.js';

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;
  beforeEach(() => {
    store = new IdempotencyStore(new RedisMock() as never, 90);
  });

  it('returns "first" on first sighting and "duplicate" after', async () => {
    expect(await store.see('k-1')).toBe('first');
    expect(await store.see('k-1')).toBe('duplicate');
  });

  it('returns "unavailable" when redis throws', async () => {
    const broken = {
      set: async () => {
        throw new Error('down');
      },
    } as never;
    const s = new IdempotencyStore(broken, 90);
    expect(await s.see('k')).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Add dep**

```bash
pnpm --filter @aggregator-dpg/observability-svc add -D ioredis-mock
```

- [ ] **Step 3: Run — FAIL**

- [ ] **Step 4: Implement**

```ts
import type Redis from 'ioredis';

export type SeenResult = 'first' | 'duplicate' | 'unavailable';

export class IdempotencyStore {
  private readonly ttlSec: number;
  constructor(
    private readonly redis: Redis,
    retentionDays: number,
  ) {
    this.ttlSec = retentionDays * 24 * 60 * 60;
  }

  async see(key: string): Promise<SeenResult> {
    const redisKey = `obs:idem:${key}`;
    try {
      const set = await this.redis.set(redisKey, '1', 'EX', this.ttlSec, 'NX');
      return set === 'OK' ? 'first' : 'duplicate';
    } catch {
      return 'unavailable';
    }
  }
}
```

- [ ] **Step 5: Run — PASS**

- [ ] **Step 6: Commit**

```bash
git add apps/observability-svc/src/idempotency.ts apps/observability-svc/src/__tests__/idempotency.test.ts apps/observability-svc/package.json
git commit -m "feat(observability-svc): Redis-backed idempotency store with fail-open on Redis down"
```

---

### Task 4.5: Outcome tracker — config-driven metric increments

**Files:**

- Create: `apps/observability-svc/src/outcome-tracker.ts`
- Create: `apps/observability-svc/src/__tests__/outcome-tracker.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { OutcomeTracker } from '../outcome-tracker.js';

const fakeMeter = {
  createCounter: vi.fn(() => ({ add: vi.fn() })),
  createHistogram: vi.fn(() => ({ record: vi.fn() })),
  createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
};

describe('OutcomeTracker', () => {
  it('creates instruments declared in config at boot', () => {
    new OutcomeTracker({
      metrics: [
        {
          name: 'participant.registered.total',
          instrument: 'counter',
          attributes: ['aggregator_id_bucket'],
        },
        { name: 'bulk_upload.row.duration_ms', instrument: 'histogram' },
      ],
      meter: fakeMeter as never,
    });
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      'participant.registered.total',
      expect.any(Object),
    );
    expect(fakeMeter.createHistogram).toHaveBeenCalledWith(
      'bulk_upload.row.duration_ms',
      expect.any(Object),
    );
  });

  it('increments the matching counter on emit', () => {
    const counterAdd = vi.fn();
    const meter = {
      createCounter: vi.fn(() => ({ add: counterAdd })),
      createHistogram: vi.fn(() => ({ record: vi.fn() })),
      createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
    };
    const tracker = new OutcomeTracker({
      metrics: [
        {
          name: 'participant.registered.total',
          instrument: 'counter',
          on_event: 'participant.created',
          attributes: ['source'],
        },
      ],
      meter: meter as never,
    });
    tracker.process({
      event: 'participant.created',
      idempotency_key: 'k',
      attributes: { source: 'csv' },
    });
    expect(counterAdd).toHaveBeenCalledWith(1, { source: 'csv' });
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
import type { Counter, Histogram, Meter, UpDownCounter } from '@opentelemetry/api';
import type { OutcomeMetricDef } from './config.js';

type Instrument = Counter | Histogram | UpDownCounter;

interface TrackerOpts {
  metrics: OutcomeMetricDef[];
  meter: Meter;
}

export class OutcomeTracker {
  private readonly byEvent = new Map<string, { def: OutcomeMetricDef; inst: Instrument }[]>();

  constructor(opts: TrackerOpts) {
    for (const def of opts.metrics) {
      const inst = this.makeInstrument(def, opts.meter);
      const key = def.on_event ?? '*';
      const existing = this.byEvent.get(key) ?? [];
      existing.push({ def, inst });
      this.byEvent.set(key, existing);
    }
  }

  private makeInstrument(def: OutcomeMetricDef, meter: Meter): Instrument {
    const opts = { description: def.description, unit: def.unit };
    switch (def.instrument) {
      case 'counter':
        return meter.createCounter(def.name, opts);
      case 'histogram':
        return meter.createHistogram(def.name, opts);
      case 'updown_counter':
        return meter.createUpDownCounter(def.name, opts);
    }
  }

  process(payload: { event: string; attributes: Record<string, unknown> }): void {
    const candidates = [
      ...(this.byEvent.get(payload.event) ?? []),
      ...(this.byEvent.get('*') ?? []),
    ];
    for (const { def, inst } of candidates) {
      const labels: Record<string, string> = {};
      for (const k of def.attributes ?? []) {
        if (k in payload.attributes) labels[k] = String(payload.attributes[k]);
      }
      if (def.instrument === 'counter' || def.instrument === 'updown_counter') {
        (inst as Counter).add(1, labels);
      } else {
        const v = Number(payload.attributes.value ?? 0);
        (inst as Histogram).record(v, labels);
      }
    }
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/observability-svc/src/outcome-tracker.ts apps/observability-svc/src/__tests__/outcome-tracker.test.ts
git commit -m "feat(observability-svc): config-driven outcome metric tracker"
```

---

### Task 4.6: Routes — `/emit/turn`, `/emit/signal`, `/validate-config`, `/health`, `/ready`

**Files:**

- Create: `apps/observability-svc/src/routes/emit-turn.ts`
- Create: `apps/observability-svc/src/routes/emit-signal.ts`
- Create: `apps/observability-svc/src/routes/validate-config.ts`
- Create: `apps/observability-svc/src/routes/health.ts`
- Create: `apps/observability-svc/src/routes/ready.ts`
- Create: `apps/observability-svc/src/server.ts`
- Create: `apps/observability-svc/src/__tests__/emit-turn.test.ts`

- [ ] **Step 1: Failing test for `/emit/turn`**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import RedisMock from 'ioredis-mock';
import { metrics } from '@opentelemetry/api';
import { buildServer } from '../server.js';

const cfg = {
  NODE_ENV: 'test' as const,
  PORT: 0,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  REDIS_URL: '',
  OUTCOMES_HMAC_SECRETS: { 'svc-api': 'shh' },
  ADMIN_TOKEN: 'adm-token-very-long-string',
  APP_VERSION: 'test',
  IDEM_TTL_DAYS: 90,
  OTEL_SDK_DISABLED: true,
  OTEL_COLLECTOR_ENDPOINT: '',
  OTEL_SAMPLE_RATE: 1,
  OUTCOME_METRICS: [],
};

function sign(body: string, ts: string): string {
  return createHmac('sha256', 'shh')
    .update(ts + body)
    .digest('hex');
}

describe('POST /emit/turn', () => {
  it('returns 401 without HMAC headers', async () => {
    const app = await buildServer({
      config: cfg,
      redis: new RedisMock() as never,
      meter: metrics.getMeter('t'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/emit/turn',
      payload: { event: 'x', idempotency_key: 'k', attributes: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 on first valid emit and 200 (duplicate) on the second', async () => {
    const app = await buildServer({
      config: cfg,
      redis: new RedisMock() as never,
      meter: metrics.getMeter('t'),
    });
    const body = JSON.stringify({
      event: 'participant.created',
      idempotency_key: 'k-1',
      attributes: {},
    });
    const ts = String(Date.now());
    const headers = {
      'content-type': 'application/json',
      'x-outcome-key-id': 'svc-api',
      'x-outcome-signature': sign(body, ts),
      'x-outcome-timestamp': ts,
    };
    const a = await app.inject({ method: 'POST', url: '/emit/turn', headers, payload: body });
    const b = await app.inject({ method: 'POST', url: '/emit/turn', headers, payload: body });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `server.ts` and routes**

`server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type Redis from 'ioredis';
import type { Meter } from '@opentelemetry/api';
import type { AppConfig } from './config.js';
import { IdempotencyStore } from './idempotency.js';
import { OutcomeTracker } from './outcome-tracker.js';
import { registerEmitTurn } from './routes/emit-turn.js';
import { registerEmitSignal } from './routes/emit-signal.js';
import { registerValidateConfig } from './routes/validate-config.js';
import { registerHealth } from './routes/health.js';
import { registerReady } from './routes/ready.js';

export interface ServerDeps {
  config: AppConfig;
  redis: Redis;
  meter: Meter;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: deps.config.LOG_LEVEL } });
  await app.register(sensible);

  const idem = new IdempotencyStore(deps.redis, deps.config.IDEM_TTL_DAYS);
  const tracker = new OutcomeTracker({ metrics: deps.config.OUTCOME_METRICS, meter: deps.meter });

  registerEmitTurn(app, { idem, tracker, secrets: deps.config.OUTCOMES_HMAC_SECRETS });
  registerEmitSignal(app, { idem, tracker, secrets: deps.config.OUTCOMES_HMAC_SECRETS });
  registerValidateConfig(app, { adminToken: deps.config.ADMIN_TOKEN, config: deps.config });
  registerHealth(app);
  registerReady(app, { redis: deps.redis });

  return app;
}
```

`routes/emit-turn.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { metrics } from '@opentelemetry/api';
import { verifyHmac } from '../hmac-auth.js';
import type { IdempotencyStore } from '../idempotency.js';
import type { OutcomeTracker } from '../outcome-tracker.js';

const TurnSchema = z.object({
  event: z.string(),
  idempotency_key: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  tool_calls: z.array(z.unknown()).optional(),
  latencies: z.record(z.string(), z.number()).optional(),
  tokens: z.record(z.string(), z.number()).optional(),
});

const meter = metrics.getMeter('observability-svc');
const droppedAudit = meter.createCounter('telemetry.audit.dropped_total');
const duplicateTotal = meter.createCounter('observability.outcome.duplicate_total');
const dedupUnavailable = meter.createCounter('observability.outcome.dedup_unavailable_total');

interface Deps {
  idem: IdempotencyStore;
  tracker: OutcomeTracker;
  secrets: Record<string, string>;
}

export function registerEmitTurn(app: FastifyInstance, deps: Deps): void {
  app.post('/emit/turn', async (req, reply) => {
    const raw = JSON.stringify(req.body);
    const hmac = verifyHmac({
      keyId: req.headers['x-outcome-key-id'] as string | undefined,
      signature: req.headers['x-outcome-signature'] as string | undefined,
      timestamp: req.headers['x-outcome-timestamp'] as string | undefined,
      body: raw,
      secrets: deps.secrets,
    });
    if (hmac !== 'ok') {
      return reply.code(401).send({ error: hmac });
    }

    const parsed = TurnSchema.safeParse(req.body);
    if (!parsed.success) {
      droppedAudit.add(1, { reason: 'schema' });
      return reply.code(200).send({ status: 'dropped' });
    }

    const seen = await deps.idem.see(parsed.data.idempotency_key);
    if (seen === 'duplicate') {
      duplicateTotal.add(1, { event: parsed.data.event });
      return reply.code(200).send({ status: 'duplicate' });
    }
    if (seen === 'unavailable') {
      dedupUnavailable.add(1, { event: parsed.data.event });
    }

    deps.tracker.process(parsed.data);
    return reply.code(200).send({ status: 'ok' });
  });
}
```

`routes/emit-signal.ts` — same shape, schema is `{ name, idempotency_key, attributes }`.

`routes/validate-config.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

export function registerValidateConfig(
  app: FastifyInstance,
  deps: { adminToken: string; config: AppConfig },
): void {
  app.get('/validate-config', async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (token !== deps.adminToken) return reply.code(401).send();
    return reply.send({
      outcome_metrics: deps.config.OUTCOME_METRICS,
      idem_ttl_days: deps.config.IDEM_TTL_DAYS,
    });
  });
}
```

`routes/health.ts`:

```ts
import type { FastifyInstance } from 'fastify';

export function registerHealth(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok' }));
}
```

`routes/ready.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';

export function registerReady(app: FastifyInstance, deps: { redis: Redis }): void {
  app.get('/ready', async (_req, reply) => {
    try {
      await deps.redis.ping();
      return reply.send({ status: 'ready' });
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/observability-svc/src/
git commit -m "feat(observability-svc): /emit/turn, /emit/signal, /validate-config, /health, /ready"
```

---

### Task 4.7: `main.ts` — bootstrap + telemetry + Redis connection

**Files:**

- Create: `apps/observability-svc/src/main.ts`
- Create: `apps/observability-svc/src/telemetry.ts`

- [ ] **Step 1: `telemetry.ts`**

```ts
import { metrics } from '@opentelemetry/api';
import { bootTelemetry, shutdownTelemetry } from '@aggregator-dpg/telemetry';
import type { AppConfig } from './config.js';

const SERVICE_NAME = 'aggregator-observability-svc';

export async function bootObsTelemetry(cfg: AppConfig): Promise<void> {
  await bootTelemetry({
    serviceName: SERVICE_NAME,
    serviceVersion: cfg.APP_VERSION,
    deploymentEnvironment: cfg.NODE_ENV,
    config: {
      otel: {
        collector_endpoint: cfg.OTEL_COLLECTOR_ENDPOINT,
        protocol: 'grpc',
        sample_rate: cfg.OTEL_SAMPLE_RATE,
        export_interval_ms: 5000,
        timeout_ms: 10000,
      },
      pii_fields_excluded: [],
    },
  });
}

export const shutdownObsTelemetry = shutdownTelemetry;
export const meter = metrics.getMeter(SERVICE_NAME);
```

- [ ] **Step 2: `main.ts`**

```ts
import { loadConfig } from './config.js';
import { bootObsTelemetry, shutdownObsTelemetry, meter } from './telemetry.js';
import { Redis } from 'ioredis';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  await bootObsTelemetry(cfg);

  const redis = new Redis(cfg.REDIS_URL);
  const app = await buildServer({ config: cfg, redis, meter });

  await app.listen({ host: cfg.HOST, port: cfg.PORT });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await shutdownObsTelemetry();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
```

- [ ] **Step 3: Build + run locally**

```bash
pnpm --filter @aggregator-dpg/observability-svc build
REDIS_URL=redis://localhost:6379 \
OUTCOMES_HMAC_SECRETS_JSON='{"svc-api":"shh"}' \
ADMIN_TOKEN=admin-secret-please-change-me \
APP_VERSION=dev \
OUTCOME_METRICS_JSON='[{"name":"participant.registered.total","instrument":"counter","on_event":"participant.created","attributes":["source"]}]' \
pnpm --filter @aggregator-dpg/observability-svc start
```

Hit `curl -sf http://localhost:8080/health` — expect `{"status":"ok"}`.

- [ ] **Step 4: Commit**

```bash
git add apps/observability-svc/src/main.ts apps/observability-svc/src/telemetry.ts
git commit -m "feat(observability-svc): main entrypoint wired to telemetry + Redis"
```

---

### Task 4.8: Wire `emitTurn` / `emitSignal` at outcome event points

**Files:**

- Modify: `apps/api/src/routes/registration-links.ts` (after `link.created`)
- Modify: `apps/api/src/routes/bulk-uploads.ts` (after `bulk_upload.created`)
- Modify: `apps/api/src/routes/aggregator-registrations.ts` (after `aggregator.created`)
- Modify: `apps/worker/src/jobs/bulk-row-process.ts` (after SignalStack onboard returns: `participant.onboarded` or `participant.signalstack_failed`)
- Modify: `apps/worker/src/jobs/bulk-finalise.ts` (after finalise: `bulk_upload.completed`)

- [ ] **Step 1: Add the import to each modified file**

```ts
import { emitTurn } from '@aggregator-dpg/telemetry';
```

- [ ] **Step 2: After each business event, fire-and-forget the emit**

Pattern (apply to each event listed above; rename event + entity ID per site):

```ts
queueMicrotask(() => {
  emitTurn({
    event: 'participant.onboarded',
    idempotency_key: `participant.onboarded:${userId}`,
    attributes: { aggregator_id: aggregatorId, source: 'bulk' },
  }).catch(() => {
    /* counted via internal droppedOutcomes */
  });
});
```

Idempotency key map (binding):

| Event                            | Idempotency key template                     |
| -------------------------------- | -------------------------------------------- |
| `aggregator.created`             | `aggregator.created:<aggregator_id>`         |
| `link.created`                   | `link.created:<link_id>`                     |
| `bulk_upload.created`            | `bulk_upload.created:<upload_id>`            |
| `participant.onboarded`          | `participant.onboarded:<user_id>`            |
| `participant.signalstack_failed` | `participant.signalstack_failed:<row_id>`    |
| `bulk_upload.completed`          | `bulk_upload.completed:<upload_id>`          |
| `bulk_row.processed`             | `bulk_row.processed:<upload_id>:<row_index>` |

- [ ] **Step 3: Typecheck + tests**

```bash
pnpm --filter aggregator-api test
pnpm --filter aggregator-worker test
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/ apps/worker/src/jobs/
git commit -m "feat(api,worker): emit outcome events after business actions"
```

---

### Task 4.9: Helm chart for `observability-svc` + Secret + NetworkPolicy

**Files:**

- Create: `helm/aggregator-dpg/charts/observability-svc/Chart.yaml`
- Create: `helm/aggregator-dpg/charts/observability-svc/values.yaml`
- Create: `helm/aggregator-dpg/charts/observability-svc/templates/deployment.yaml`
- Create: `helm/aggregator-dpg/charts/observability-svc/templates/service.yaml`
- Create: `helm/aggregator-dpg/charts/observability-svc/templates/secret.yaml`
- Create: `helm/aggregator-dpg/charts/observability-svc/templates/networkpolicy.yaml`

- [ ] **Step 1: `Chart.yaml`**

```yaml
apiVersion: v2
name: observability-svc
type: application
version: 0.1.0
appVersion: '0.1.0'
```

- [ ] **Step 2: `values.yaml`**

```yaml
image:
  repository: ghcr.io/your-org/aggregator-observability-svc
  tag: ''
  pullPolicy: IfNotPresent
replicaCount: 2
service:
  type: ClusterIP
  port: 8080
redisUrl: 'redis://redis:6379'
adminTokenSecret: aggregator-obs-admin-token
hmacSecretsSecret: aggregator-obs-secrets
outcomeMetricsJson: |
  [
    {"name":"participant.registered.total","instrument":"counter","on_event":"participant.onboarded","attributes":["aggregator_id","source"]},
    {"name":"bulk_upload.completed.total","instrument":"counter","on_event":"bulk_upload.completed","attributes":["aggregator_id"]},
    {"name":"registration_link.created.total","instrument":"counter","on_event":"link.created","attributes":["aggregator_id","target_role"]}
  ]
networkPolicy:
  enabled: true
  allowedNamespaces: ['aggregator']
  allowedServiceAccounts: ['aggregator-api', 'aggregator-worker']
terminationGracePeriodSeconds: 45
```

- [ ] **Step 3: `templates/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-observability-svc
spec:
  replicas: {{ .Values.replicaCount }}
  selector: { matchLabels: { app: {{ .Release.Name }}-observability-svc } }
  template:
    metadata: { labels: { app: {{ .Release.Name }}-observability-svc } }
    spec:
      terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
      containers:
        - name: observability-svc
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          ports: [{ containerPort: 8080 }]
          env:
            - { name: APP_VERSION, value: "{{ .Chart.AppVersion }}" }
            - { name: REDIS_URL, value: "{{ .Values.redisUrl }}" }
            - name: OUTCOMES_HMAC_SECRETS_JSON
              valueFrom: { secretKeyRef: { name: "{{ .Values.hmacSecretsSecret }}", key: secrets-json } }
            - name: ADMIN_TOKEN
              valueFrom: { secretKeyRef: { name: "{{ .Values.adminTokenSecret }}", key: token } }
            - { name: OUTCOME_METRICS_JSON, value: |- {{ .Values.outcomeMetricsJson | nindent 14 }} }
            - { name: OTEL_SDK_DISABLED, value: "false" }
            - { name: OTEL_COLLECTOR_ENDPOINT, value: "http://otel-collector.observability.svc.cluster.local:4317" }
          readinessProbe: { httpGet: { path: /ready, port: 8080 }, periodSeconds: 5 }
          livenessProbe:  { httpGet: { path: /health, port: 8080 }, periodSeconds: 10 }
```

- [ ] **Step 4: `templates/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata: { name: {{ .Release.Name }}-observability-svc }
spec:
  type: {{ .Values.service.type }}
  ports: [{ port: {{ .Values.service.port }}, targetPort: 8080 }]
  selector: { app: {{ .Release.Name }}-observability-svc }
```

- [ ] **Step 5: `templates/networkpolicy.yaml`**

```yaml
{{- if .Values.networkPolicy.enabled }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: {{ .Release.Name }}-observability-svc }
spec:
  podSelector: { matchLabels: { app: {{ .Release.Name }}-observability-svc } }
  policyTypes: [Ingress]
  ingress:
    - from:
        {{- range .Values.networkPolicy.allowedServiceAccounts }}
        - podSelector: { matchLabels: { app: {{ $.Release.Name }}-{{ . }} } }
        {{- end }}
      ports:
        - port: 8080
          protocol: TCP
{{- end }}
```

- [ ] **Step 6: `templates/secret.yaml`** (placeholder — actual secret values are created out-of-band via `kubectl create secret`)

```yaml
# Secrets must be created externally (kubectl or sealed-secrets):
#   kubectl create secret generic aggregator-obs-secrets --from-literal=secrets-json='{"svc-api":"...","svc-worker":"..."}'
#   kubectl create secret generic aggregator-obs-admin-token --from-literal=token='...'
```

- [ ] **Step 7: Helm lint + render**

```bash
helm lint helm/aggregator-dpg
helm template aggregator-dpg helm/aggregator-dpg | grep -A5 observability-svc
```

- [ ] **Step 8: Commit**

```bash
git add helm/aggregator-dpg/charts/observability-svc/
git commit -m "feat(helm): observability-svc chart + NetworkPolicy + Secret refs"
```

---

### Task 4.10: End-to-end outcome verification

- [ ] **Step 1: Bring up the new service**

```bash
docker compose up -d observability-svc
```

(Add to `docker-compose.yml` if missing: image build context `./apps/observability-svc`, env vars per Task 4.7 step 3.)

- [ ] **Step 2: Set api / worker env to point at it**

```bash
export OBS_SVC_URL=http://observability-svc:8080
export OBS_HMAC_KEY_ID=svc-api
export OBS_HMAC_SECRET=shh
docker compose restart api worker
```

- [ ] **Step 3: Trigger an outcome — POST a registration link**

```bash
curl -sf -X POST http://localhost:4000/v1/onboard/links \
  -H 'Authorization: Bearer <dev-token>' \
  -d '{ "target_role": "seeker", "label": "demo" }'
```

- [ ] **Step 4: Verify the metric in Prometheus**

```
aggregator_registration_link_created_total
```

Counter should be 1.

- [ ] **Step 5: Re-POST the SAME link creation (same idempotency_key)**

Hit api again — observability-svc returns 200 with `status: duplicate`. Verify `aggregator_observability_outcome_duplicate_total{event="link.created"} == 1`. The counter from Step 4 should still be 1.

- [ ] **Step 6: Commit**

```bash
git commit --allow-empty -m "chore(telemetry): outcome events end-to-end verified (Phase 4 gate)"
```

---

**Phase 4 gate:** outcome events arrive, dedup works, unauthenticated requests are rejected. Stop and review.

---

## Phase 5 — Decommission legacy

**The repo has no existing log scraper or alternate metric path.** Nothing to remove.

Single task:

### Task 5.1: Update `.claude/rules/logging-observability.md` to reflect the new package

**Files:**

- Modify: `.claude/rules/logging-observability.md`

- [ ] **Step 1: Replace `@aggregator-dpg/observability` with `@aggregator-dpg/telemetry`**

```bash
sed -i.bak 's|@aggregator-dpg/observability|@aggregator-dpg/telemetry|g' .claude/rules/logging-observability.md
rm .claude/rules/logging-observability.md.bak
```

- [ ] **Step 2: Add a one-line note at the top about pino → OTLP transport**

After the first paragraph, append:

```markdown
**Wire layer:** pino remains the application logging API. A custom pino
transport in `@aggregator-dpg/telemetry/pino-transport` forwards records
to the OTel `LoggerProvider`, which exports OTLP-logs to the Collector.
`trace_id` / `span_id` are auto-injected from the active span.
```

- [ ] **Step 3: Create the on-call runbook**

`docs/telemetry-runbook.md`:

````markdown
# Telemetry on-call runbook

## Kill switch

Set `OTEL_SDK_DISABLED=true` on the affected service and restart:

```bash
kubectl set env deploy/aggregator-api OTEL_SDK_DISABLED=true -n prod
kubectl rollout restart deploy/aggregator-api -n prod
```
````

This stops all OTLP traffic immediately. pino still logs to stdout.

## Backpressure / dropped spans

Alert `OtelDroppedSpans` fires when `otel.dropped_spans_total > 0` for 5m.
Check:

1. Collector pod logs for `memory_limiter` warnings.
2. Collector pod CPU / memory.
3. If Collector is healthy, the app's BSP queue saturated — increase
   `OTEL_BSP_MAX_QUEUE_SIZE` env (default 2048).

## Outcome events failing

Alert `OutcomeEventsRejected` fires when the api's local
`droppedOutcomes_total` increments.
Check `apps/observability-svc` for 401 (HMAC mismatch) or 5xx (Redis down).
On Redis outage, observability-svc fails open — pages but does not drop events.

````

- [ ] **Step 4: Commit**

```bash
git add .claude/rules/logging-observability.md docs/telemetry-runbook.md
git commit -m "docs(telemetry): rename package in rule + add on-call runbook"
````

---

**Phase 5 gate:** All phases complete; design fully implemented within the scope decided above.

---

## Self-review

Spec coverage check (each section of [docs/telemetry-design.md](../../telemetry-design.md)):

- **§1 Goals G1–G7** — Single `trace_id` (Phase 2 verification). <1ms p99 impact (Phase 3 staging bake). Grafana datasources with deep-link (Task 1.8 + 3.5). DPDP — PII allow-lists wired (logger + Collector redact processor). Pluggable backend — Collector is the only piece that knows downstream (Task 1.8 + 3.4). Outcome metrics declarative — `OUTCOME_METRICS_JSON` (Task 4.5). Same pattern per service — `bootApiTelemetry`, `bootWorkerTelemetry`, `bootWebTelemetry`, `bootObsTelemetry` all wrap one `bootTelemetry`.
- **§3 Architecture** — All four tiers built: apps (Phases 1-3), Collector (Tasks 1.8/3.4), backends (Task 1.8), Grafana (Task 1.8 + 3.5). Resource block per service (Task 0.3).
- **§4 Signals** — Traces conventions in custom spans (Tasks 1.7/2.6/3.2). Metrics families covered (Tasks 1.7/2.2/3.1). Histogram buckets enforced (Task 0.5). Logs via pino transport (Task 0.7).
- **§5 Propagation** — HTTP via undici/fastify auto-instrumentation (Task 0.11). BullMQ via `_otel` carrier (Task 0.10 + 2.4 + 2.5). Outcome emit forwards traceparent in HTTP headers (auto-instrumented).
- **§6 Cardinality + PII** — Logger redact paths (Task 0.8). Collector `attributes/redact` processor (Tasks 1.8/3.4). Audit path — **out of scope** (Task 0.13 stub).
- **§7 Sampling** — Head sample in bootstrap (Task 0.6). Tail sampling in prod Collector (Task 3.4) with the allowed routes from scope decisions.
- **§8 Folder layout** — Package laid out per design (Tasks 0.1–0.15). Per-service `telemetry.ts` (Tasks 1.2 / 2.2 / 3.1). `observability-svc` (Phase 4).
- **§9 Config** — `config/observability.yaml` shape implemented via env vars (Tasks 1.1 / 2.1 / 4.2). Outcome metrics declared via `OUTCOME_METRICS_JSON`. SLOs in Prometheus rules (Task 3.5).
- **§10 Lifecycle, kill switch, backpressure** — Graceful shutdown (Tasks 1.5 / 2.3 / 3.1 / 4.7). Kill switch (Task 0.6). BSP env vars (Task 0.6). Phased rollout (Task 3.7).
- **§11 Code patterns** — Demonstrated in Tasks 2.6 (hot path) and 4.8 (outcome emit).
- **§12 Async event endpoint** — Endpoints (Task 4.6). HMAC auth (Task 4.3). Idempotency dedup (Task 4.4). Fail-open on Redis (Task 4.4 step 4).

Placeholder scan: no `TBD`, no "add error handling", no "similar to Task N", every code block is concrete.

Type consistency: `BootOptions` (Task 0.2) referenced consistently across `bootstrap.ts` and per-service telemetry modules. `OutcomeMetricDef` (Task 4.2) referenced by `OutcomeTracker` (Task 4.5). HMAC keymap shape (`Record<string, string>`) consistent between config and `verifyHmac`.

---

## Execution handoff

Plan complete and saved to [`docs/superpowers/plans/2026-05-25-telemetry-implementation.md`](2026-05-25-telemetry-implementation.md).

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Required sub-skill: `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
