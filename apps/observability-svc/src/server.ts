/**
 * Fastify server factory for the observability-svc.
 *
 * Wires all route handlers together with their shared dependencies
 * (idempotency store, outcome tracker, config) and returns a ready-to-listen
 * FastifyInstance. Callers invoke `app.listen()` separately so tests can
 * inject via `app.inject()` without binding a real port.
 *
 * @module observability-svc/server
 * @package @aggregator-dpg/observability-svc
 */

import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { Meter } from '@opentelemetry/api';
import type { AppConfig } from './config.js';
import { IdempotencyStore } from './idempotency.js';
import { OutcomeTracker } from './outcome-tracker.js';
import { registerEmitTurn } from './routes/emit-turn.js';
import { registerEmitSignal } from './routes/emit-signal.js';
import { registerValidateConfig } from './routes/validate-config.js';
import { registerHealth } from './routes/health.js';
import { registerReady } from './routes/ready.js';

/** Dependencies required to build the server. */
export interface ServerDeps {
  /** Validated runtime configuration. */
  config: AppConfig;
  /** Connected ioredis client (or compatible mock for tests). */
  redis: Redis;
  /** OTel Meter used to create outcome instruments in OutcomeTracker. */
  meter: Meter;
}

/**
 * Creates and configures the Fastify server instance with all routes registered.
 *
 * Registers `@fastify/sensible` for error helpers, then mounts:
 * - `POST /emit/turn` — conversational-turn outcome ingestion
 * - `POST /emit/signal` — named-signal outcome ingestion
 * - `GET /validate-config` — admin config inspection (requires Bearer token)
 * - `GET /health` — liveness probe
 * - `GET /ready` — readiness probe (checks Redis)
 *
 * @param deps - Server dependencies: config, Redis client, and OTel Meter.
 * @returns A fully configured FastifyInstance ready to listen or inject.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL as
        | 'silent'
        | 'info'
        | 'debug'
        | 'warn'
        | 'error'
        | 'fatal'
        | 'trace',
    },
  });
  await app.register(sensible);

  // Capture the raw JSON body bytes so HMAC verification can hash the exact
  // bytes the producer signed — not a re-serialisation that may reorder keys.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const parsed = (body as string).length === 0 ? {} : JSON.parse(body as string);
      // Stash the raw string for HMAC verification.
      (_req as unknown as { rawBody: string }).rawBody = body as string;
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const idem = new IdempotencyStore(deps.redis, deps.config.IDEM_TTL_DAYS);
  const tracker = new OutcomeTracker({ metrics: deps.config.OUTCOME_METRICS, meter: deps.meter });

  registerEmitTurn(app, { idem, tracker, secrets: deps.config.OUTCOMES_HMAC_SECRETS });
  registerEmitSignal(app, { idem, tracker, secrets: deps.config.OUTCOMES_HMAC_SECRETS });
  registerValidateConfig(app, { adminToken: deps.config.ADMIN_TOKEN, config: deps.config });
  registerHealth(app);
  registerReady(app, { redis: deps.redis });

  return app;
}
