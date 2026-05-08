/**
 * Builds the Fastify app instance. Kept separate from `server.ts` so tests
 * can spin up an in-memory app without binding to a network port.
 *
 * Wires:
 *   - request id generation + propagation via `x-request-id`
 *   - per-request structured logging (entry + exit + latency)
 *   - global error handler that renders the canonical error envelope
 */

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import { config, corsOrigins } from './config.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAggregatorRegistrationRoutes } from './routes/aggregator-registrations.js';
import { registerAggregatorApprovalRoutes } from './routes/aggregator-approvals.js';
import { registerAggregatorProfileRoutes } from './routes/aggregator-profile.js';
import { registerBulkUploadsRoutes } from './routes/bulk-uploads.js';
import { registerRegistrationLinksRoutes } from './routes/registration-links.js';
import { registerPublicRegistrationLinkRoutes } from './routes/public-registration-links.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { ERR } from './errors/codes.js';
import { HttpError } from './errors/http-error.js';
import { coerceToHttpError, toEnvelope, toLogPayload } from './errors/serialize.js';

const REQUEST_ID_HEADER = 'x-request-id';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      base: { service: 'aggregator-api', env: config.NODE_ENV },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.password',
          '*.token',
          '*.access_token',
          '*.refresh_token',
        ],
        censor: '[REDACTED]',
      },
      ...(config.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss.l',
                singleLine: false,
                ignore: 'pid,hostname,service,env',
              },
            },
          }
        : {}),
    },
    trustProxy: true,
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

  await app.register(cors, {
    origin: corsOrigins.length === 0 || corsOrigins.includes('*') ? true : corsOrigins,
    credentials: false,
  });
  await app.register(formbody);
  await app.register(sensible);

  app.addHook('onRequest', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
    req.log.info(
      { event: 'request.start', method: req.method, url: req.url },
      `→ ${req.method} ${req.url}`,
    );
  });

  app.addHook('onResponse', async (req, reply) => {
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

  await registerHealthRoutes(app);
  await registerAggregatorRegistrationRoutes(app);
  await registerAggregatorApprovalRoutes(app);
  await registerAggregatorProfileRoutes(app);
  await registerBulkUploadsRoutes(app);
  await registerRegistrationLinksRoutes(app);
  await registerPublicRegistrationLinkRoutes(app);
  await registerOnboardingRoutes(app);

  app.setErrorHandler((rawErr, req, reply) => {
    // Fastify schema validation error — promote to a typed HttpError so the
    // envelope shape matches the rest of the API.
    const fastifyValidation = (rawErr as { validation?: unknown[] }).validation;
    let err: HttpError;
    if (Array.isArray(fastifyValidation) && fastifyValidation.length > 0) {
      err = new HttpError(ERR.SCHEMA_VALIDATION, {
        cause: rawErr,
        fields: { issues: fastifyValidation },
      });
    } else {
      err = coerceToHttpError(rawErr);
    }

    const includeStack = config.NODE_ENV !== 'production';
    const logPayload = toLogPayload(err, includeStack);

    if (err.status >= 500) {
      req.log.error(logPayload, err.title);
    } else {
      req.log.warn(logPayload, err.title);
    }

    return reply.status(err.status).send(toEnvelope(err, req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    const err = new HttpError(ERR.NOT_FOUND, {
      detail: `No route for ${req.method} ${req.url}`,
    });
    req.log.warn(toLogPayload(err, false), err.title);
    return reply.status(err.status).send(toEnvelope(err, req.id));
  });

  return app;
}
