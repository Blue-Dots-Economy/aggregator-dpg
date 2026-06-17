/**
 * Admin endpoints for aggregator registrations.
 *
 * These routes live under `/admin/v1/` so an external API gateway (Kong,
 * Keycloak token-exchange, etc.) can apply a single route-level policy to
 * any path matching `/admin/**` without application-level key checks.
 * The application trusts that only authenticated admin traffic reaches these
 * handlers.
 *
 * Endpoints:
 *   GET  /admin/v1/aggregator/registration              — paginated list
 *   GET  /admin/v1/aggregator/registration/:id          — single row
 *   POST /admin/v1/aggregator/registration/reconcile    — full reconcile tick
 *   POST /admin/v1/aggregator/registration/reconcile/by-contact — single-row repair
 */

import { type FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/client.js';
import { runRegistrationReconcile, reconcileByContact } from '../jobs/registration-reconcile.js';
import { HttpError } from '../errors/http-error.js';
import { ERR } from '../errors/codes.js';

// ─── Schema constants ─────────────────────────────────────────────────────────

const VALID_STATES = [
  'submitted',
  'verified',
  'approved',
  'active',
  'rejected',
  'abandoned',
] as const;

type RegistrationState = (typeof VALID_STATES)[number];

const ListQuerySchema = z.object({
  state: z.enum(VALID_STATES).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sort: z.enum(['created_at', 'updated_at']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const ByContactBodySchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(1).optional(),
  })
  .refine((d) => d.email ?? d.phone, {
    message: 'Provide either email or phone.',
  });

// ─── Registration row view ─────────────────────────────────────────────────

function toAdminView(row: typeof schema.registrations.$inferSelect) {
  return {
    id: row.id,
    org_name: row.orgName,
    org_type: row.orgType,
    org_url: row.orgUrl,
    contact_email: row.contactEmail,
    contact_phone: row.contactPhone,
    state: row.state,
    aggregator_id: row.aggregatorId,
    signalstack_org_id: row.signalstackOrgId,
    provision_state: row.provisionState,
    admin_notified_at: row.adminNotifiedAt,
    verification_sent_at: row.verificationSentAt,
    reconciler_claimed_at: row.reconcilerClaimedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * Registers admin endpoints for aggregator registrations under `/admin/v1`.
 *
 * @param app - The Fastify instance to register routes on.
 */
export async function registerAggregatorRegistrationsAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  // ── GET /admin/v1/aggregator/registration ────────────────────────────────
  app.get<{
    Querystring: {
      state?: string;
      page?: string;
      limit?: string;
      sort?: string;
      order?: string;
    };
  }>('/admin/v1/aggregator/registration', async (req, reply) => {
    const query = ListQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new HttpError(ERR.SCHEMA_VALIDATION, {
        fields: { issues: query.error.issues },
      });
    }

    const { state, page, limit, sort, order } = query.data;
    const offset = (page - 1) * limit;

    const sortCol =
      sort === 'updated_at' ? schema.registrations.updatedAt : schema.registrations.createdAt;
    const orderFn = order === 'asc' ? asc : desc;

    const whereClause = state
      ? and(inArray(schema.registrations.state, [state as RegistrationState]))
      : undefined;

    const [rows, countRows] = await Promise.all([
      getDb()
        .select()
        .from(schema.registrations)
        .where(whereClause)
        .orderBy(orderFn(sortCol))
        .limit(limit)
        .offset(offset),
      getDb()
        .select({ count: schema.registrations.id })
        .from(schema.registrations)
        .where(whereClause),
    ]);

    return reply.send({
      items: rows.map(toAdminView),
      total: countRows.length,
      page,
      limit,
    });
  });

  // ── GET /admin/v1/aggregator/registration/:id ────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/admin/v1/aggregator/registration/:id',
    async (req, reply) => {
      const row = await getDb().query.registrations.findFirst({
        where: eq(schema.registrations.id, req.params.id),
      });

      if (!row) {
        throw new HttpError(ERR.NOT_FOUND, {
          detail: `Registration ${req.params.id} not found.`,
        });
      }

      const transitions = await getDb()
        .select()
        .from(schema.registrationTransitions)
        .where(eq(schema.registrationTransitions.registrationId, row.id))
        .orderBy(asc(schema.registrationTransitions.at));

      return reply.send({
        ...toAdminView(row),
        profile_draft: row.profileDraft,
        org_locations: row.orgLocations,
        transitions,
      });
    },
  );

  // ── POST /admin/v1/aggregator/registration/reconcile ────────────────────
  app.post('/admin/v1/aggregator/registration/reconcile', async (req, reply) => {
    const outcome = await runRegistrationReconcile();
    return reply.status(200).send(outcome);
  });

  // ── POST /admin/v1/aggregator/registration/reconcile/by-contact ─────────
  app.post<{ Body: { email?: string; phone?: string } }>(
    '/admin/v1/aggregator/registration/reconcile/by-contact',
    async (req, reply) => {
      const body = ByContactBodySchema.safeParse(req.body);
      if (!body.success) {
        throw new HttpError(ERR.SCHEMA_VALIDATION, {
          fields: { issues: body.error.issues },
        });
      }

      const { email, phone } = body.data;

      let result: Awaited<ReturnType<typeof reconcileByContact>>;
      if (email) {
        result = await reconcileByContact('email', email);
      } else {
        result = await reconcileByContact('phone', phone!);
      }

      if (result.examined === 0) {
        throw new HttpError(ERR.NOT_FOUND, {
          detail: 'No non-terminal registration found for the provided contact.',
        });
      }

      const { registration, ...outcome } = result;
      return reply.send({
        ...outcome,
        registration: registration ? toAdminView(registration) : null,
      });
    },
  );
}
