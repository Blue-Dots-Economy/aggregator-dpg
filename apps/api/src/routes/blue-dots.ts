/**
 * Blue-dots dashboard endpoints.
 *
 *   GET /v1/blue-dots/items?domain=seeker|provider&limit&offset
 *     Returns every signalstack profile tagged with the caller aggregator's
 *     aggregator_id, scoped to the requested domain. Used by the /blue-dots
 *     page to render the participant table.
 *
 * Authorisation: Bearer access token with the custom `aggregator_id` claim.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';

const BlueDotsQuerySchema = z.object({
  domain: z.enum(['seeker', 'provider']),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

type BlueDotsQuery = z.infer<typeof BlueDotsQuerySchema>;

const ITEM_TYPE_BY_DOMAIN: Record<BlueDotsQuery['domain'], string> = {
  seeker: 'profile_1.0',
  provider: 'job_posting_1.0',
};

export async function registerBlueDotsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/blue-dots/items', async (req, reply) => {
    const auth = await requireAuth(req);
    const log = req.log.child({
      operation: 'blue-dots.items',
      aggregator_id: auth.aggregatorId,
    });
    const start = Date.now();

    const parsed = BlueDotsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'Invalid query parameters.',
        fields: { issues: parsed.error.issues },
      });
    }
    const { domain, limit, offset } = parsed.data;

    const ss = getSignalStackWriter();
    if (!ss) {
      log.warn({ status: 'failure', sub: 'signalstack.disabled' });
      throw httpError('INTERNAL', {
        detail: 'Signalstack push is not configured for this environment.',
      });
    }

    const result = await ss.listItemsByAggregator({
      aggregator_id: auth.aggregatorId,
      item_network: config.SIGNALSTACK_ITEM_NETWORK,
      item_domain: domain,
      item_type: ITEM_TYPE_BY_DOMAIN[domain],
      limit,
      offset,
    });

    if (!result.success) {
      log.error({
        status: 'failure',
        sub: 'signalstack.list',
        error: result.error.message,
        code: result.error.code,
      });
      throw httpError('INTERNAL', {
        detail: `Signalstack list failed: ${result.error.code}`,
        cause: result.error,
      });
    }

    log.info({
      status: 'success',
      latency_ms: Date.now() - start,
      total: result.value.meta.total,
    });

    return reply.send(result.value);
  });
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}
