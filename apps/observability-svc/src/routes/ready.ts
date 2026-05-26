/**
 * GET /ready — readiness probe for the observability-svc.
 *
 * PINGs Redis; returns HTTP 200 when the store is reachable, or HTTP 503
 * when it is not. Used by Kubernetes readiness gates to gate traffic.
 *
 * @module observability-svc/routes/ready
 * @package @aggregator-dpg/observability-svc
 */

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

/** Dependencies required by the readiness route. */
interface Deps {
  /** Connected ioredis client used to verify store reachability. */
  redis: Redis;
}

/**
 * Registers the `/ready` readiness route on the given Fastify instance.
 *
 * @param app - The Fastify application instance to register the route on.
 * @param deps - Route dependencies, primarily the Redis client.
 */
export function registerReady(app: FastifyInstance, deps: Deps): void {
  app.get('/ready', async (_req, reply) => {
    try {
      await deps.redis.ping();
      return reply.send({ status: 'ready' });
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
}
