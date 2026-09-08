/**
 * Dashboard endpoints.
 *
 *   GET /v1/dashboard/items?domain=seeker|provider&limit&offset
 *     Returns every signalstack profile tagged with the caller aggregator's
 *     aggregator_id, scoped to the requested domain. Used by the /blue-dots
 *     page to render the participant table.
 *
 *   GET /v1/dashboard?domain=seeker&page&limit&status
 *     Proxies signalstack's pre-computed aggregator dashboard payload
 *     (rollup + paginated participants + cursor + metadata) for the
 *     calling aggregator's signalstack org. `domain` defaults to `seeker`;
 *     `provider` is accepted for forward-compat but signalstack's
 *     dashboard endpoint is seeker-only today and the writer drops the
 *     field on the upstream call until that lands.
 *
 * Authorisation: Bearer access token with the custom `aggregator_id` claim.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorResponses } from '../errors/openapi.js';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import { buildDecryptedProfilesCsv } from '@aggregator-dpg/profile-csv';
import { httpError } from '../errors/http-error.js';

/**
 * Lifecycle statuses the aggregator dashboard surfaces. Signals filters the
 * rollup + items to this set (paused + retired are excluded). Broaden here if
 * a deployment should show more buckets.
 */
const DASHBOARD_LIFECYCLE = ['draft', 'live'] as const;

/**
 * Max `item_ids` accepted by the decrypted-profile export in one call.
 *
 * This is a PII decrypt path, and the array was previously unbounded — one
 * request could ask signalstack to decrypt arbitrarily many profiles. 1000 is
 * comfortably wider than any window the dashboard renders, so the bound is
 * invisible to a real export while capping the blast radius of a crafted one.
 */
const EXPORT_MAX_ITEM_IDS = 1000;

/**
 * Dashboard query schema. `status` is a pass-through with a light shape
 * check — signalstack owns the canonical set (`new`, `at_risk`,
 * `accepted`, `rejected`, …) and our API does not pin an enum that would
 * drift on every signalstack release. `domain` defaults to seeker so
 * existing seeker-only consumers keep working; provider support flips on
 * once signalstack's dashboard endpoint accepts a domain filter.
 */
const DashboardQuerySchema = z.object({
  domain: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  status: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/i, 'status must be alphanumeric + underscore')
    .optional(),
  /**
   * Optional lifecycle narrowing for the participant list. When set, only that
   * lifecycle is fetched (and paginated) upstream; absent ⇒ the default
   * draft+live set ({@link DASHBOARD_LIFECYCLE}). Server-side so a rare draft
   * surfaces in a domain dominated by live profiles — client-side filtering a
   * single page cannot. `paused`/`retired` remain non-selectable here.
   */
  lifecycle: z.enum(['draft', 'live']).optional(),
  /** Bypass signalstack's TTL cache when true. Forwarded verbatim. */
  refresh: z.coerce.boolean().optional().default(false),
});

/**
 * Export query schema. Strict subset of {@link DashboardQuerySchema} —
 * signalstack's `/dashboard/export` endpoint accepts only `status` as a
 * filter today. `domain` is validated against the resolved network
 * config in the handler.
 */
const DashboardExportQuerySchema = z.object({
  domain: z.string().min(1).optional(),
  status: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_]+$/i, 'status must be alphanumeric + underscore')
    .optional(),
  refresh: z.coerce.boolean().optional().default(false),
});

const ExportProfilesBodySchema = z.object({
  item_ids: z.array(z.string().min(1)).min(1).max(EXPORT_MAX_ITEM_IDS),
  domain: z.string().min(1).optional(),
});

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/dashboard',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Aggregator dashboard rollup + items',
        description:
          "Proxies signalstack's pre-computed dashboard payload (rollup + paginated participants + cursor + metadata) for the caller aggregator. by_domain[<id>] contains seeker/provider slices; refresh=true bypasses the TTL cache. The 200 payload is proxied verbatim from signalstack, so no response schema is pinned (avoids a deep zod re-parse of the rollup on every reply).",
        security: [{ bearerAuth: [] }],
        querystring: DashboardQuerySchema,
        // 200 carries no schema on purpose — see description.
        response: { ...errorResponses(400, 401, 403, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await requireApprovedAuth(req);
      const log = req.log.child({
        operation: 'dashboard',
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      // Validated (and defaulted) by the route's `querystring` zod schema.
      const query = req.query as z.infer<typeof DashboardQuerySchema>;
      const { page, limit, status, lifecycle, refresh } = query;
      const networkCfg = await getNetworkConfig();
      const domain = query.domain ?? networkCfg.domainIds[0]!;
      if (!networkCfg.domains[domain]) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
        });
      }

      const ss = getSignalStackWriter();
      if (!ss) {
        log.warn({ status: 'failure', sub: 'signalstack.disabled' });
        throw httpError('INTERNAL', {
          detail: 'Signalstack is not configured for this environment.',
        });
      }

      const actingOrgId = await resolveActingOrgId(auth, log);

      const result = await ss.fetchDashboard({
        actingOrgId,
        requestId: req.id,
        page,
        limit,
        ...(status ? { status } : {}),
        domain,
        // Aggregator dashboard shows only draft + live profiles; paused +
        // retired are excluded server-side by signalstack (#lifecycle-filter).
        // A caller-supplied `?lifecycle=` narrows to that single lifecycle
        // (server-side pagination over the filtered set); absent ⇒ draft+live.
        lifecycle: lifecycle ? [lifecycle] : DASHBOARD_LIFECYCLE,
        refresh,
      });

      if (!result.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.dashboard',
          error: result.error.message,
          code: result.error.code,
        });
        throw httpError('INTERNAL', {
          detail: `Signalstack dashboard fetch failed: ${result.error.code}`,
          cause: result.error,
        });
      }

      // Signalstack now returns every served domain in one payload under
      // `by_domain[<id>]`. Log the requested domain's slice for parity
      // with the previous single-domain log shape; the response itself
      // is forwarded verbatim so the web app can render seeker + provider
      // tabs from a single fetch.
      const slice = result.value.by_domain[domain];
      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        domain,
        page,
        limit,
        status_filter: status ?? null,
        total_matching: slice?.total_matching ?? null,
        items_total: slice?.rollup.total_items ?? null,
        refreshed: result.value.metadata.refreshed,
      });

      return reply.send(result.value);
    },
  );

  app.get(
    '/v1/dashboard/export',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'CSV export of dashboard items',
        description:
          'Returns a CSV (text/csv) of the dashboard items for the caller aggregator. Filters by optional status. Body is the CSV text, with Content-Disposition: attachment.',
        security: [{ bearerAuth: [] }],
        querystring: DashboardExportQuerySchema,
        // 200 carries no schema — the reply is a text/csv attachment.
        response: { ...errorResponses(400, 401, 403, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await requireApprovedAuth(req);
      const log = req.log.child({
        operation: 'dashboard.export',
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      // Validated (and defaulted) by the route's `querystring` zod schema.
      const query = req.query as z.infer<typeof DashboardExportQuerySchema>;
      const { status, refresh } = query;
      const networkCfg = await getNetworkConfig();
      const domain = query.domain ?? networkCfg.domainIds[0]!;
      if (!networkCfg.domains[domain]) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
        });
      }

      const ss = getSignalStackWriter();
      if (!ss) {
        log.warn({ status: 'failure', sub: 'signalstack.disabled' });
        throw httpError('INTERNAL', {
          detail: 'Signalstack is not configured for this environment.',
        });
      }

      const actingOrgId = await resolveActingOrgId(auth, log);

      const result = await ss.exportDashboardCsv({
        actingOrgId,
        requestId: req.id,
        ...(status ? { status } : {}),
        domain,
        refresh,
      });

      if (!result.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.dashboard.export',
          error: result.error.message,
          code: result.error.code,
        });
        throw httpError('INTERNAL', {
          detail: `Signalstack dashboard export failed: ${result.error.code}`,
          cause: result.error,
        });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        domain,
        status_filter: status ?? null,
        bytes: result.value.csv.length,
        filename: result.value.filename,
      });

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="${result.value.filename.replaceAll('"', '')}"`,
        )
        .send(result.value.csv);
    },
  );

  app.post(
    '/v1/dashboard/export/profiles',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'CSV export of DECRYPTED profile data for selected items',
        description:
          'Returns a CSV (text/csv) of decrypted profile data for the given item_ids, scoped to the caller aggregator. The signalstack admin key never leaves the server.',
        security: [{ bearerAuth: [] }],
        body: ExportProfilesBodySchema,
        response: { ...errorResponses(400, 401, 403, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await requireApprovedAuth(req);
      const log = req.log.child({
        operation: 'dashboard.export.profiles',
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      const { item_ids, domain: requestedDomain } = req.body as z.infer<
        typeof ExportProfilesBodySchema
      >;
      const networkCfg = await getNetworkConfig();
      const domain = requestedDomain ?? networkCfg.domainIds[0]!;
      if (!networkCfg.domains[domain]) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
        });
      }

      const ss = getSignalStackWriter();
      if (!ss) {
        log.warn({ status: 'failure', sub: 'signalstack.disabled' });
        throw httpError('INTERNAL', {
          detail: 'Signalstack is not configured for this environment.',
        });
      }

      const actingOrgId = await resolveActingOrgId(auth, log);
      const result = await ss.fetchDecryptedProfiles({
        actingOrgId,
        itemIds: item_ids,
        requestId: req.id,
      });
      if (!result.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.profiles.decrypt',
          error: result.error.message,
          code: result.error.code,
        });
        throw httpError('INTERNAL', {
          detail: `Signalstack profile decrypt failed: ${result.error.code}`,
          cause: result.error,
        });
      }

      const rows: SignalStackDecryptedProfileRow[] = result.value.profiles;
      const csv = buildDecryptedProfilesCsv(rows);
      const filename = `profiles-${domain}-${new Date().toISOString().slice(0, 10)}.csv`;

      // Do NOT log item_state values (PII). Counts only.
      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        domain,
        requested: item_ids.length,
        returned: rows.length,
        skipped: result.value.skipped.length,
        bytes: csv.length,
      });

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename.replaceAll('"', '')}"`)
        .send(csv);
    },
  );
}

/**
 * Resolves the aggregator's signalstack organisation id for routes that
 * proxy reads against signalstack. Prefers the access-token claim
 * (`requireApproved` triggers the login-time backfill and mutates
 * `context.signalstackOrgId` in place when the claim is absent) and
 * falls back to the Postgres mirror so a token-refresh delay between
 * approval and first dashboard hit does not strand the user.
 *
 * Throws DB_UNAVAILABLE if the store read fails, and
 * SIGNALSTACK_ORG_NOT_REGISTERED when neither source carries a value —
 * which means the aggregator has not yet completed the signalstack
 * handshake (login backfill must run once before reads work).
 */
async function resolveActingOrgId(auth: AuthContext, log: FastifyRequest['log']): Promise<string> {
  let actingOrgId: string | null = auth.signalstackOrgId ?? null;
  if (!actingOrgId) {
    const row = await getAggregatorStore().findById(auth.aggregatorId);
    if (!row.ok) {
      log.error({
        status: 'failure',
        sub: 'aggregatorStore.findById',
        code: row.error.code,
      });
      throw httpError('DB_UNAVAILABLE', {
        fields: { sub_operation: 'aggregatorStore.findById' },
      });
    }
    actingOrgId = row.value?.signalstackOrgId ?? null;
  }
  if (!actingOrgId) {
    log.warn({ status: 'failure', sub: 'signalstack.org_not_registered' });
    throw httpError('SIGNALSTACK_ORG_NOT_REGISTERED', {
      fields: { aggregator_id: auth.aggregatorId },
    });
  }
  return actingOrgId;
}

/**
 * Approval-gated auth helper for routes that consume signalstack on the
 * caller's behalf. Promotes a missing `aggregator_id` claim to 403 (FORBIDDEN)
 * and a non-approved decision to 403 (NOT_APPROVED) so the caller can
 * distinguish "no claim wired" from "still pending approval".
 */
async function requireApprovedAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (result.ok) return result.context;
  if (result.error.code === 'MISSING_AGGREGATOR_ID') {
    throw httpError('FORBIDDEN', {
      detail: result.error.message,
      fields: { reason: result.error.code },
    });
  }
  if (result.error.code === 'NOT_APPROVED') {
    throw httpError('NOT_APPROVED', {
      detail: result.error.message,
      fields: { reason: result.error.code },
    });
  }
  throw httpError('UNAUTHORIZED', {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}
