/**
 * Aggregator profile endpoints (post-login).
 *
 *   GET /v1/aggregators/profile/me
 *     Returns the authenticated aggregator's profile JSON + a derived
 *     `is_complete` flag.
 *
 *   PUT /v1/aggregators/profile/me
 *     Validates the body against `profile.v1.json` and replaces the
 *     profile's `data` + `consent` JSONB blobs.
 *
 * Authorisation: Bearer access token from Keycloak, with a custom
 * `aggregator_id` claim mapped from the user attribute.
 *
 * Failures are surfaced by throwing `httpError(<CODE>)`; the global error
 * handler renders the canonical envelope.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorProfileStore } from '../services/aggregator-profile-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpUser } from '../services/idp-admin/index.js';
import { getProfileValidator } from '../services/profile-validator.js';
import { httpError } from '../errors/http-error.js';

export async function registerAggregatorProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/aggregators/profile/me', async (req, reply) => {
    const auth = await requireAuth(req);
    const log = req.log.child({ operation: 'aggregator-profile.read', actor: auth.userId });
    const start = Date.now();

    const profileStore = getAggregatorProfileStore();
    const aggregatorStore = getAggregatorStore();

    const aggregator = await aggregatorStore.findById(auth.aggregatorId);
    if (!aggregator.ok) {
      throw httpError('DB_UNAVAILABLE', { cause: aggregator.error });
    }
    if (!aggregator.value) {
      throw httpError('NOT_FOUND', { detail: 'Aggregator record not found.' });
    }

    const profile = await profileStore.findByAggregatorId(auth.aggregatorId);
    if (!profile.ok) {
      throw httpError('DB_UNAVAILABLE', { cause: profile.error });
    }
    if (!profile.value) {
      // Submit flow always inserts an empty profile — this should never fire.
      throw httpError('NOT_FOUND', { detail: 'Profile record missing.' });
    }

    const kcUser = await fetchKcUserSafe(auth, log);

    log.info(
      { status: 'success', latency_ms: Date.now() - start, aggregator_id: auth.aggregatorId },
      'profile read',
    );

    return reply.send({
      aggregator_id: auth.aggregatorId,
      org_slug: aggregator.value.orgSlug,
      org_name: pickAttribute(kcUser, KC_ATTR.ASSOCIATION) ?? aggregator.value.orgSlug,
      type: aggregator.value.type,
      identity: {
        first_name: auth.firstName ?? kcUser?.firstName ?? null,
        last_name: auth.lastName ?? kcUser?.lastName ?? null,
        email: auth.email ?? kcUser?.email ?? null,
        email_verified: auth.emailVerified ?? false,
        phone: auth.phoneNumber ?? pickAttribute(kcUser, KC_ATTR.PHONE_NUMBER) ?? null,
        phone_verified:
          auth.phoneNumberVerified ?? pickAttribute(kcUser, 'phoneNumberVerified') === 'true',
        active: kcUser?.enabled ?? true,
      },
      schema_version: profile.value.schemaVersion,
      data: profile.value.data,
      consent: profile.value.consent,
      is_complete: isProfileComplete(profile.value.data),
      created_at: aggregator.value.createdAt.toISOString(),
      updated_at: profile.value.updatedAt.toISOString(),
    });
  });

  app.put('/v1/aggregators/profile/me', async (req, reply) => {
    const auth = await requireAuth(req);
    const log = req.log.child({ operation: 'aggregator-profile.update', actor: auth.userId });
    const start = Date.now();

    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    const consent = (body.consent ?? {}) as Record<string, unknown>;

    const validate = getProfileValidator();
    if (!validate(data)) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'Profile data failed schema validation.',
        fields: { issues: validate.errors ?? [] },
      });
    }

    const profileStore = getAggregatorProfileStore();
    const updated = await profileStore.update(auth.aggregatorId, {
      data,
      consent,
      updatedBy: auth.userId,
    });
    if (!updated.ok) {
      if (updated.error.code === 'NOT_FOUND') {
        throw httpError('NOT_FOUND', { detail: 'Profile record missing.', cause: updated.error });
      }
      throw httpError('DB_UNAVAILABLE', { cause: updated.error });
    }

    log.info(
      {
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: auth.aggregatorId,
      },
      'profile updated',
    );

    return reply.send({
      aggregator_id: auth.aggregatorId,
      schema_version: updated.value.schemaVersion,
      data: updated.value.data,
      consent: updated.value.consent,
      is_complete: isProfileComplete(updated.value.data),
      updated_at: updated.value.updatedAt.toISOString(),
    });
  });
}

async function fetchKcUserSafe(auth: AuthContext, log: FastifyBaseLogger): Promise<IdpUser | null> {
  try {
    const result = await getIdpAdmin().findById(auth.userId);
    if (result.ok) return result.value ?? null;
    log.warn(
      { sub_operation: 'fetchKcUser', code: result.error.code, hint: result.error.message },
      'failed to load KC user — falling back to JWT claims',
    );
    return null;
  } catch (err) {
    log.warn(
      {
        sub_operation: 'fetchKcUser',
        cause: err instanceof Error ? err.message : String(err),
      },
      'failed to load KC user (threw)',
    );
    return null;
  }
}

function pickAttribute(user: IdpUser | null, name: string): string | undefined {
  const v = user?.attributes?.[name];
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].length > 0) return v[0];
  return undefined;
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

function isProfileComplete(data: Record<string, unknown>): boolean {
  const who = data.who_i_am as Record<string, unknown> | undefined;
  const want = data.what_i_want as Record<string, unknown> | undefined;
  const have = data.what_i_have as Record<string, unknown> | undefined;
  if (!who || typeof who.display_name !== 'string' || !who.display_name) return false;
  if (!want || !Array.isArray(want.beneficiary_groups) || want.beneficiary_groups.length === 0) {
    return false;
  }
  if (!have || typeof have.network_size !== 'number') return false;
  return true;
}
