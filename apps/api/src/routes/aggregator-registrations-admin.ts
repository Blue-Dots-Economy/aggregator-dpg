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
import { getRegistrationStore } from '../services/registration-store/index.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorProfileStore } from '../services/aggregator-profile-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { getMailer } from '../services/mailer/index.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { config, adminEmails } from '../config.js';
import {
  ensureVerificationSent,
  ensureAdminNotified,
  ensureGraduated,
  ensureKeycloakUser,
  ensureSignalstackOrg,
  ensureWelcomeSent,
} from '../services/registration-provisioning/index.js';
import type {
  Registration,
  RegistrationState,
  TransitionPatch,
} from '../services/registration-store/interface.js';
import { logger } from '../logger.js';
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

  // ── POST /admin/v1/aggregator/registration/reopen/:id ────────────────────
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/admin/v1/aggregator/registration/reopen/:id',
    async (req, reply) => {
      const store = getRegistrationStore();
      const { id } = req.params;

      const findResult = await store.findById(id);
      if (!findResult.ok) {
        throw new HttpError(ERR.DB_UNAVAILABLE, { detail: findResult.error.message });
      }
      if (!findResult.value) {
        throw new HttpError(ERR.NOT_FOUND, { detail: `Registration ${id} not found.` });
      }

      const reg = findResult.value;
      if (reg.state !== 'abandoned') {
        throw new HttpError(ERR.CONFLICT, {
          detail: `Registration is in state '${reg.state}', not 'abandoned'. Only abandoned registrations can be re-opened.`,
          fields: { current_state: reg.state },
        });
      }

      // Determine target state from the transition history.
      const preStateResult = await store.getPreAbandonmentState(id);
      const targetState =
        preStateResult.ok && preStateResult.value ? preStateResult.value : 'submitted';

      const resetPatch = buildReopenPatch(targetState);
      const transResult = await store.transition(
        id,
        'abandoned',
        targetState,
        resetPatch,
        reg.version,
        {
          actor: 'admin',
          reason: (req.body?.reason ?? 'admin_reopened') || 'admin_reopened',
        },
      );

      if (!transResult.ok) {
        if (transResult.error.code === 'STALE_TRANSITION') {
          // Concurrent re-open — re-read and return current state.
          const fresh = await store.findById(id);
          return reply.send({
            reopened: true,
            targetState,
            registration:
              fresh.ok && fresh.value
                ? toAdminView(fresh.value as Parameters<typeof toAdminView>[0])
                : null,
          });
        }
        throw new HttpError(ERR.DB_UNAVAILABLE, { detail: transResult.error.message });
      }

      // Best-effort inline provisioning based on target state.
      void fireReopenProvisioning(transResult.value, targetState).catch((err: unknown) => {
        logger.warn({
          operation: 'admin.reopen.provisioning',
          status: 'failed',
          registration_id: id,
          target_state: targetState,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      logger.info({
        operation: 'admin.reopen',
        status: 'success',
        registration_id: id,
        target_state: targetState,
        actor: 'admin',
      });

      return reply.send({ reopened: true, targetState });
    },
  );
}

// ─── Re-open helpers ──────────────────────────────────────────────────────────

/**
 * Builds the transition patch for a re-open based on the target state.
 *
 * - Back to `submitted`: full reset — the applicant must re-verify.
 * - Back to `verified`: preserve verification-done, reset admin-notify timestamps
 *   so the admin notification is resent.
 * - Back to `approved`: only clear the reconciler claim; provision_state is
 *   preserved so the reconciler retries only incomplete steps.
 *
 * @param targetState - State to re-open to.
 */
function buildReopenPatch(targetState: RegistrationState): TransitionPatch {
  if (targetState === 'submitted') {
    return {
      verificationSentAt: null,
      verifiedAt: null,
      adminNotifiedAt: null,
      approvalLinkIssuedAt: null,
      provisionState: {},
      reconcilerClaimedAt: null,
    };
  }
  if (targetState === 'verified') {
    return {
      adminNotifiedAt: null,
      approvalLinkIssuedAt: null,
      provisionState: { verification: 'done' },
      reconcilerClaimedAt: null,
    };
  }
  // approved — keep provision_state; only release the reconciler claim.
  return { reconcilerClaimedAt: null };
}

/**
 * Fires provisioning steps inline after an admin re-open.
 *
 * @param reg - The freshly re-opened registration.
 * @param targetState - The state the registration was re-opened to.
 */
async function fireReopenProvisioning(
  reg: Registration,
  targetState: RegistrationState,
): Promise<void> {
  const store = getRegistrationStore();
  const mailer = getMailer();

  if (targetState === 'submitted') {
    await ensureVerificationSent(reg, {
      store,
      mailer,
      portalUrl: config.PUBLIC_PORTAL_URL,
      cooldownMinutes: config.REGISTRATION_RESEND_COOLDOWN_MINUTES,
      ttlMinutes: config.REGISTRATION_VERIFICATION_TTL_MINUTES,
    });
    return;
  }

  if (targetState === 'verified') {
    await ensureAdminNotified(reg, {
      store,
      mailer,
      adminEmails,
      apiUrl: config.PUBLIC_API_URL,
      cooldownMinutes: config.REGISTRATION_RESEND_COOLDOWN_MINUTES,
    });
    return;
  }

  if (targetState === 'approved') {
    const aggregatorStore = getAggregatorStore();
    const aggregatorProfileStore = getAggregatorProfileStore();
    const idpAdmin = getIdpAdmin();
    const signalStackWriter = getSignalStackWriter();

    await ensureGraduated(reg, { store, aggregatorStore, aggregatorProfileStore });
    // Re-read after graduation so subsequent steps see the updated aggregatorId.
    const fresh = await store.findById(reg.id);
    const graduated = fresh.ok && fresh.value ? fresh.value : reg;
    await ensureKeycloakUser(graduated, { store, idpAdmin });
    if (signalStackWriter) {
      await ensureSignalstackOrg(graduated, { store, aggregatorStore, signalStackWriter });
    }
    await ensureWelcomeSent(graduated, { store, mailer, portalUrl: config.PUBLIC_PORTAL_URL });
  }
}
