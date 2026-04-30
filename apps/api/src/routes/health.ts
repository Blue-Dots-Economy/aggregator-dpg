/**
 * Liveness and readiness probes consumed by container orchestrators and the
 * compose healthcheck.
 */

import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => ({ status: 'ok' }));
}
