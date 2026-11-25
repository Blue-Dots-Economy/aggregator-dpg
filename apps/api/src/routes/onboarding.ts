/**
 * Onboarding metrics endpoints of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET /v1/onboarding/summary       totals across both sources
 *   GET /v1/onboarding/by-source     bulk vs link breakdown
 *
 * Reads only from the `onboarding` rollup table. Bulk rows are written by
 * the Finaliser (one per upload). Link rows are written by the Metrics
 * Coordinator (one per (aggregator, link, hour-bucket)).
 *
 * `?domain=` narrows both reads to one profile type, taken from the row's
 * upload (`bulk_uploads.participant_type`) or registration link
 * (`registration_links.domain`).
 */

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../services/auth/access-token.js';
import { getDb } from '../db/client.js';
import { bulkUploads, onboarding, registrationLinks } from '../db/schema.js';
import { errorResponses } from '../errors/openapi.js';
import { getNetworkConfig } from '../services/network-config.js';
import { servedDomains } from '../services/user-store/serves.js';
import { resolveRequestedDomain } from './served-domains-shared.js';
import { requireCoordinatorAuth } from './coordinator-auth-shared.js';

const RangeQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  domain: z
    .string()
    .min(1)
    .optional()
    .describe('Profile type (network domain id) to count; omitted counts every profile type.'),
});

/** Shared counter columns summed from the onboarding rollup table. */
const OnboardingCountersSchema = z.object({
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});

const OnboardingSummaryResponseSchema = OnboardingCountersSchema.extend({
  aggregator_id: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
}).loose();

const OnboardingBySourceResponseSchema = z
  .object({
    aggregator_id: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    by_source: z.array(OnboardingCountersSchema.extend({ source: z.string() }).loose()),
  })
  .loose();

export function registerOnboardingRoutes(base: FastifyInstance): void {
  const app = base.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/v1/onboarding/summary',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['onboarding'],
        summary: 'Aggregated onboarding totals',
        description:
          'Sum of total / passed / failed / skipped onboarding attempts for the caller aggregator, optionally constrained by ?from=&to= ISO dates and narrowed to one profile type by ?domain=.',
        security: [{ bearerAuth: [] }],
        querystring: RangeQuerySchema,
        response: {
          200: OnboardingSummaryResponseSchema,
          ...errorResponses(400, 401, 403),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireCoordinatorAuth(req);
      const { range, where } = await metricsFilter(auth, req.query);

      const rows = await getDb()
        .select({
          total: sql<number>`COALESCE(SUM(${onboarding.total}), 0)::int`,
          passed: sql<number>`COALESCE(SUM(${onboarding.passed}), 0)::int`,
          failed: sql<number>`COALESCE(SUM(${onboarding.failed}), 0)::int`,
          skipped: sql<number>`COALESCE(SUM(${onboarding.skipped}), 0)::int`,
        })
        .from(onboarding)
        .where(where);

      const r = rows[0] ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
      return reply.send({
        aggregator_id: auth.userId,
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        ...r,
      });
    },
  );

  app.get(
    '/v1/onboarding/by-source',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['onboarding'],
        summary: 'Onboarding totals grouped by source',
        description:
          'Per-source breakdown of onboarding counters for the caller aggregator (e.g. by_link / by_bulk_upload), optionally date-bounded by ?from=&to= and narrowed to one profile type by ?domain=.',
        security: [{ bearerAuth: [] }],
        querystring: RangeQuerySchema,
        response: {
          200: OnboardingBySourceResponseSchema,
          ...errorResponses(400, 401, 403),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireCoordinatorAuth(req);
      const { range, where } = await metricsFilter(auth, req.query);

      const rows = await getDb()
        .select({
          source: onboarding.source,
          total: sql<number>`COALESCE(SUM(${onboarding.total}), 0)::int`,
          passed: sql<number>`COALESCE(SUM(${onboarding.passed}), 0)::int`,
          failed: sql<number>`COALESCE(SUM(${onboarding.failed}), 0)::int`,
          skipped: sql<number>`COALESCE(SUM(${onboarding.skipped}), 0)::int`,
        })
        .from(onboarding)
        .where(where)
        .groupBy(onboarding.source);

      return reply.send({
        aggregator_id: auth.userId,
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        by_source: rows,
      });
    },
  );
}

/**
 * The filter both metrics reads share: the caller's rows, the date range and the profile type.
 *
 * @param auth - The verified caller.
 * @param query - The validated query.
 * @returns The parsed range, echoed in the response, and the where clause.
 * @throws SCHEMA_VALIDATION if `domain` is not a network domain.
 * @throws DOMAIN_NOT_SERVED if the caller does not serve `domain`.
 */
async function metricsFilter(
  auth: AuthContext,
  query: z.infer<typeof RangeQuerySchema>,
): Promise<{ range: { from?: Date; to?: Date }; where: SQL | undefined }> {
  const range = parseRange(query);
  const conditions = [eq(onboarding.userId, auth.userId)];
  if (range.from) conditions.push(gte(onboarding.periodStart, range.from));
  if (range.to) conditions.push(lte(onboarding.periodEnd, range.to));
  const byType = await profileTypeCondition(auth, query.domain);
  if (byType) conditions.push(byType);
  return { range, where: and(...conditions) };
}

/**
 * The condition that keeps only rows of the requested profile type.
 *
 * A row's type comes from its upload or registration link. With one served
 * type every row counts, so the totals match the unfiltered read; this also
 * keeps rollups whose upload was removed by the retention purge.
 *
 * @param auth - The verified caller.
 * @param requested - The `?domain=` value, if any.
 * @returns The condition, or `undefined` when no filtering is needed.
 * @throws SCHEMA_VALIDATION if `requested` is not a network domain.
 * @throws DOMAIN_NOT_SERVED if the caller does not serve `requested`.
 */
async function profileTypeCondition(
  auth: AuthContext,
  requested: string | undefined,
): Promise<SQL | undefined> {
  if (requested === undefined) return undefined;
  const domain = await resolveRequestedDomain(auth, requested);
  const { domainIds } = await getNetworkConfig();
  if (servedDomains(auth.serves, domainIds).length <= 1) return undefined;
  return sql`(${onboarding.batchId} IN (SELECT ${bulkUploads.id} FROM ${bulkUploads} WHERE ${bulkUploads.participantType} = ${domain}) OR ${onboarding.linkId} IN (SELECT ${registrationLinks.id} FROM ${registrationLinks} WHERE ${registrationLinks.domain} = ${domain}))`;
}

/**
 * Converts the validated `?from=&to=` query into Date bounds.
 *
 * @param query - The zod-validated range query from `req.query`.
 * @returns Optional from/to Date bounds.
 */
function parseRange(query: z.infer<typeof RangeQuerySchema>): { from?: Date; to?: Date } {
  const out: { from?: Date; to?: Date } = {};
  if (query.from) out.from = new Date(query.from);
  if (query.to) out.to = new Date(query.to);
  return out;
}
