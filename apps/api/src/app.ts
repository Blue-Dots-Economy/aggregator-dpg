/**
 * Builds the Fastify app instance. Kept separate from `server.ts` so tests
 * can spin up an in-memory app without binding to a network port.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import { config, corsOrigins } from './config.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAggregatorRegistrationRoutes } from './routes/aggregator-registrations.js';
import { registerAggregatorApprovalRoutes } from './routes/aggregator-approvals.js';
import { registerAggregatorProfileRoutes } from './routes/aggregator-profile.js';

/**
 * Creates and wires a Fastify app instance with shared plugins and routes.
 *
 * @returns A ready-to-listen Fastify app.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
          }
        : {}),
    },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: corsOrigins.length === 0 || corsOrigins.includes('*') ? true : corsOrigins,
    credentials: false,
  });
  await app.register(formbody);
  await app.register(sensible);

  await registerHealthRoutes(app);
  await registerAggregatorRegistrationRoutes(app);
  await registerAggregatorApprovalRoutes(app);
  await registerAggregatorProfileRoutes(app);

  app.setErrorHandler((err, _req, reply) => {
    app.log.error({ err }, 'unhandled error');
    const e = err as { statusCode?: number; name?: string; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({
        error: e.name ?? 'BadRequest',
        message: e.message ?? 'request failed',
      });
    }
    return reply.status(500).send({
      error: 'InternalServerError',
      message:
        config.NODE_ENV === 'production' ? 'internal error' : (e.message ?? 'internal error'),
    });
  });

  return app;
}
