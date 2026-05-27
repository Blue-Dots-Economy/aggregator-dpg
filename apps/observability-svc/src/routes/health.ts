/**
 * GET /health — liveness probe for the observability-svc.
 *
 * Returns HTTP 200 with `{ status: 'ok' }` whenever the process is alive.
 * No external dependencies are checked; use /ready for that.
 *
 * @module observability-svc/routes/health
 * @package @aggregator-dpg/observability-svc
 */

import type { FastifyInstance } from 'fastify';

/**
 * Registers the `/health` liveness route on the given Fastify instance.
 *
 * @param app - The Fastify application instance to register the route on.
 */
export function registerHealth(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok' }));
}
