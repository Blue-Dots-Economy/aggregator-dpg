/**
 * Liveness and readiness probes consumed by container orchestrators and the
 * compose healthcheck.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const HealthResponseSchema = z.object({ status: z.literal('ok') });

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        description: 'Returns 200 as long as the process is up — used by Docker healthcheck.',
        response: { 200: HealthResponseSchema },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness probe',
        description: 'Returns 200 when the api is ready to accept traffic.',
        response: { 200: HealthResponseSchema },
      },
    },
    async () => ({ status: 'ok' as const }),
  );
}
