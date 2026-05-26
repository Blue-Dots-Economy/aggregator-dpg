/**
 * POST /emit/turn — ingest a conversational-turn outcome event.
 *
 * Validates the HMAC-SHA256 signature, deduplicates via the idempotency store,
 * and routes the event to the OutcomeTracker for metric recording.
 *
 * Responds 401 on auth failure. Responds 200 with a `status` discriminant
 * (`ok` | `duplicate` | `dropped`) rather than 4xx on soft failures so
 * producers do not retry healthy events.
 *
 * @module observability-svc/routes/emit-turn
 * @package @aggregator-dpg/observability-svc
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { metrics } from '@opentelemetry/api';
import { verifyHmac } from '../hmac-auth.js';
import type { IdempotencyStore } from '../idempotency.js';
import type { OutcomeTracker } from '../outcome-tracker.js';

/** Zod schema for an inbound turn outcome event. */
const TurnSchema = z.object({
  event: z.string(),
  idempotency_key: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  tool_calls: z.array(z.unknown()).optional(),
  latencies: z.record(z.string(), z.number()).optional(),
  tokens: z.record(z.string(), z.number()).optional(),
});

const meter = metrics.getMeter('observability-svc');
const droppedSchema = meter.createCounter('telemetry.audit.dropped_total');
const duplicateTotal = meter.createCounter('observability.outcome.duplicate_total');
const dedupUnavailable = meter.createCounter('observability.outcome.dedup_unavailable_total');

/** Dependencies injected into the emit-turn route handler. */
interface Deps {
  /** Idempotency store for deduplication. */
  idem: IdempotencyStore;
  /** Outcome tracker for routing events to OTel instruments. */
  tracker: OutcomeTracker;
  /** Map of HMAC keyId → shared secret loaded from config. */
  secrets: Record<string, string>;
}

/**
 * Registers the `POST /emit/turn` route on the given Fastify instance.
 *
 * @param app - The Fastify application instance to register the route on.
 * @param deps - Route dependencies: idempotency store, outcome tracker, and HMAC secrets.
 */
export function registerEmitTurn(app: FastifyInstance, deps: Deps): void {
  app.post('/emit/turn', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
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
      droppedSchema.add(1, { reason: 'schema' });
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
