/**
 * Onboarding metrics endpoints.
 *
 *   GET /v1/onboarding/summary       totals across both sources
 *   GET /v1/onboarding/by-source     bulk vs link breakdown
 *
 * Reads only from the `onboarding` rollup table. Bulk rows are written by
 * the Finaliser (one per upload). Link rows are written by the Metrics
 * Aggregator (one per (aggregator, link, hour-bucket)).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getDb } from '../db/client.js';
import { onboarding } from '../db/schema.js';
import { httpError } from '../errors/http-error.js';
import { withAggregatorBaggage } from '@aggregator-dpg/telemetry';

const RangeQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export async function registerOnboardingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/onboarding/summary', async (req, reply) => {
    const auth = await requireAuth(req);
    return withAggregatorBaggage(auth.aggregatorId, async () => {
      const range = parseRange(req);
      const conditions = [eq(onboarding.aggregatorId, auth.aggregatorId)];
      if (range.from) conditions.push(gte(onboarding.periodStart, range.from));
      if (range.to) conditions.push(lte(onboarding.periodEnd, range.to));

      const rows = await getDb()
        .select({
          total: sql<number>`COALESCE(SUM(${onboarding.total}), 0)::int`,
          passed: sql<number>`COALESCE(SUM(${onboarding.passed}), 0)::int`,
          failed: sql<number>`COALESCE(SUM(${onboarding.failed}), 0)::int`,
          skipped: sql<number>`COALESCE(SUM(${onboarding.skipped}), 0)::int`,
        })
        .from(onboarding)
        .where(and(...conditions));

      const r = rows[0] ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
      return reply.send({
        aggregator_id: auth.aggregatorId,
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        ...r,
      });
    });
  });

  app.get('/v1/onboarding/by-source', async (req, reply) => {
    const auth = await requireAuth(req);
    return withAggregatorBaggage(auth.aggregatorId, async () => {
      const range = parseRange(req);
      const conditions = [eq(onboarding.aggregatorId, auth.aggregatorId)];
      if (range.from) conditions.push(gte(onboarding.periodStart, range.from));
      if (range.to) conditions.push(lte(onboarding.periodEnd, range.to));

      const rows = await getDb()
        .select({
          source: onboarding.source,
          total: sql<number>`COALESCE(SUM(${onboarding.total}), 0)::int`,
          passed: sql<number>`COALESCE(SUM(${onboarding.passed}), 0)::int`,
          failed: sql<number>`COALESCE(SUM(${onboarding.failed}), 0)::int`,
          skipped: sql<number>`COALESCE(SUM(${onboarding.skipped}), 0)::int`,
        })
        .from(onboarding)
        .where(and(...conditions))
        .groupBy(onboarding.source);

      return reply.send({
        aggregator_id: auth.aggregatorId,
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        by_source: rows,
      });
    });
  });
}

function parseRange(req: FastifyRequest): { from?: Date; to?: Date } {
  const parsed = RangeQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'Query parameters failed validation.',
      fields: { issues: parsed.error.issues },
    });
  }
  const out: { from?: Date; to?: Date } = {};
  if (parsed.data.from) out.from = new Date(parsed.data.from);
  if (parsed.data.to) out.to = new Date(parsed.data.to);
  return out;
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (!result.ok) {
    if (result.error.code === 'NOT_APPROVED') {
      throw httpError('NOT_APPROVED', { detail: result.error.message });
    }
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.aggregatorId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing aggregator_id claim.' });
  }
  return result.context;
}
