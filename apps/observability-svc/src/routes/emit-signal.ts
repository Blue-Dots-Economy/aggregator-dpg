/**
 * POST /emit/signal — ingest a named signal outcome event.
 *
 * Validates the HMAC-SHA256 signature, deduplicates via the idempotency store,
 * and routes the signal to the OutcomeTracker mapped as `{ event: name, attributes }`.
 *
 * Responds 401 on auth failure. Responds 200 with a `status` discriminant
 * (`ok` | `duplicate` | `dropped`) rather than 4xx on soft failures so
 * producers do not retry healthy events.
 *
 * @module observability-svc/routes/emit-signal
 * @package @aggregator-dpg/observability-svc
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { metrics } from '@opentelemetry/api';
import { verifyHmac } from '../hmac-auth.js';
import type { IdempotencyStore } from '../idempotency.js';
import type { OutcomeTracker } from '../outcome-tracker.js';

/** Zod schema for an inbound signal outcome event. */
const SignalSchema = z.object({
  name: z.string(),
  idempotency_key: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});

const meter = metrics.getMeter('observability-svc');
const droppedSchema = meter.createCounter('telemetry.audit.dropped_total');
const duplicateTotal = meter.createCounter('observability.outcome.duplicate_total');
const dedupUnavailable = meter.createCounter('observability.outcome.dedup_unavailable_total');

/** Dependencies injected into the emit-signal route handler. */
interface Deps {
  /** Idempotency store for deduplication. */
  idem: IdempotencyStore;
  /** Outcome tracker for routing signals to OTel instruments. */
  tracker: OutcomeTracker;
  /** Map of HMAC keyId → shared secret loaded from config. */
  secrets: Record<string, string>;
}

/**
 * Registers the `POST /emit/signal` route on the given Fastify instance.
 *
 * @param app - The Fastify application instance to register the route on.
 * @param deps - Route dependencies: idempotency store, outcome tracker, and HMAC secrets.
 */
export function registerEmitSignal(app: FastifyInstance, deps: Deps): void {
  app.post('/emit/signal', async (req, reply) => {
    const raw = JSON.stringify(req.body ?? {});
    const hmac = verifyHmac({
      keyId: req.headers['x-outcome-key-id'] as string | undefined,
      signature: req.headers['x-outcome-signature'] as string | undefined,
      timestamp: req.headers['x-outcome-timestamp'] as string | undefined,
      body: raw,
      secrets: deps.secrets,
    });
    if (hmac !== 'ok') return reply.code(401).send({ error: hmac });

    const parsed = SignalSchema.safeParse(req.body);
    if (!parsed.success) {
      droppedSchema.add(1, { reason: 'schema' });
      return reply.code(200).send({ status: 'dropped' });
    }

    const seen = await deps.idem.see(parsed.data.idempotency_key);
    if (seen === 'duplicate') {
      duplicateTotal.add(1, { event: parsed.data.name });
      return reply.code(200).send({ status: 'duplicate' });
    }
    if (seen === 'unavailable') {
      dedupUnavailable.add(1, { event: parsed.data.name });
    }

    // OutcomeTracker expects { event, attributes }; map signal.name → event field
    deps.tracker.process({ event: parsed.data.name, attributes: parsed.data.attributes });
    return reply.code(200).send({ status: 'ok' });
  });
}
