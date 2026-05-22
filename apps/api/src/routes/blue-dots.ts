/**
 * Blue-dots dashboard endpoints.
 *
 *   GET /v1/blue-dots/items?domain=seeker|provider&limit&offset
 *     Returns every signalstack profile tagged with the caller aggregator's
 *     aggregator_id, scoped to the requested domain. Used by the /blue-dots
 *     page to render the participant table.
 *
 *   GET /v1/blue-dots/dashboard?domain=seeker&page&limit&status
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
import { authenticate, requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';

/**
 * Domain accepts any string at the schema layer — the resolved network
 * config decides which ids are valid for the live deployment. The route
 * handler validates against `config.domainIds` after parse.
 */
const BlueDotsQuerySchema = z.object({
  domain: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

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
});

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

    const networkCfg = await getNetworkConfig();
    const domainCfg = networkCfg.domains[domain];
    if (!domainCfg) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: `unknown domain '${domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
      });
    }

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
      item_type: domainCfg.itemType,
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

  app.get('/v1/blue-dots/dashboard', async (req, reply) => {
    const auth = await requireApprovedAuth(req);
    const log = req.log.child({
      operation: 'blue-dots.dashboard',
      aggregator_id: auth.aggregatorId,
    });
    const start = Date.now();

    const parsed = DashboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'Invalid query parameters.',
        fields: { issues: parsed.error.issues },
      });
    }
    const { page, limit, status } = parsed.data;
    const networkCfg = await getNetworkConfig();
    const domain = parsed.data.domain ?? networkCfg.domainIds[0]!;
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
      page,
      limit,
      ...(status ? { status } : {}),
      domain,
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

    log.info({
      status: 'success',
      latency_ms: Date.now() - start,
      domain,
      page,
      limit,
      status_filter: status ?? null,
      total_matching: result.value.total_matching,
      participants_total: result.value.rollup.participants_total,
      refreshed: result.value.metadata.refreshed,
    });

    return reply.send(result.value);
  });

  app.get('/v1/blue-dots/dashboard/export', async (req, reply) => {
    const auth = await requireApprovedAuth(req);
    const log = req.log.child({
      operation: 'blue-dots.dashboard.export',
      aggregator_id: auth.aggregatorId,
    });
    const start = Date.now();

    const parsed = DashboardExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'Invalid query parameters.',
        fields: { issues: parsed.error.issues },
      });
    }
    const { status } = parsed.data;
    const networkCfg = await getNetworkConfig();
    const domain = parsed.data.domain ?? networkCfg.domainIds[0]!;
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
      ...(status ? { status } : {}),
      domain,
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
        `attachment; filename="${result.value.filename.replace(/"/g, '')}"`,
      )
      .send(result.value.csv);
  });
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

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}
