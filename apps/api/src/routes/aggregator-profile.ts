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
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorProfileStore } from '../services/aggregator-profile-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpUser } from '../services/idp-admin/index.js';
import { getProfileValidator } from '../services/profile-validator.js';
import { logger } from '../logger.js';

export async function registerAggregatorProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/aggregators/profile/me', async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return reply;

    const profileStore = getAggregatorProfileStore();
    const aggregatorStore = getAggregatorStore();

    const aggregator = await aggregatorStore.findById(auth.aggregatorId);
    if (!aggregator.ok || !aggregator.value) {
      return reply.status(404).send({
        error: 'NotFound',
        message: 'aggregator not found',
      });
    }

    const profile = await profileStore.findByAggregatorId(auth.aggregatorId);
    if (!profile.ok) {
      return reply.status(503).send({
        error: 'ServiceUnavailable',
        message: profile.error.message,
      });
    }
    if (!profile.value) {
      // Should not happen — submit flow always inserts an empty profile.
      return reply.status(404).send({
        error: 'NotFound',
        message: 'profile not found',
      });
    }

    // Pull KC attributes (association, phone) the access token may not
    // surface as claims by default. The BFF holds the access token; the
    // browser never sees this call.
    const kcUser = await fetchKcUserSafe(auth);

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
    const auth = await requireAuth(req, reply);
    if (!auth) return reply;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    const consent = (body.consent ?? {}) as Record<string, unknown>;

    const validate = getProfileValidator();
    if (!validate(data)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'profile data failed schema validation',
        details: validate.errors,
      });
    }

    const profileStore = getAggregatorProfileStore();
    const updated = await profileStore.update(auth.aggregatorId, {
      data,
      consent,
      updatedBy: auth.userId,
    });
    if (!updated.ok) {
      const status = updated.error.code === 'NOT_FOUND' ? 404 : 503;
      return reply.status(status).send({
        error: status === 404 ? 'NotFound' : 'ServiceUnavailable',
        code: updated.error.code,
        message: updated.error.message,
      });
    }

    logger.info({
      operation: 'aggregator-profile.update',
      status: 'success',
      aggregator_id: auth.aggregatorId,
      user_id: auth.userId,
    });

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

async function fetchKcUserSafe(auth: AuthContext): Promise<IdpUser | null> {
  try {
    const result = await getIdpAdmin().findById(auth.userId);
    if (result.ok) return result.value ?? null;
    logger.warn({
      operation: 'aggregator-profile.fetchKcUser',
      status: 'failure',
      error: result.error.message,
      error_code: result.error.code,
    });
    return null;
  } catch (err) {
    logger.warn({
      operation: 'aggregator-profile.fetchKcUser',
      status: 'failure',
      error: (err as Error).message,
    });
    return null;
  }
}

function pickAttribute(user: IdpUser | null, name: string): string | undefined {
  const v = user?.attributes?.[name];
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].length > 0) return v[0];
  return undefined;
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> {
  const result = await authenticate(req);
  if (result.ok) return result.context;
  const status = result.error.code === 'MISSING_AGGREGATOR_ID' ? 403 : 401;
  await reply.status(status).send({
    error: status === 403 ? 'Forbidden' : 'Unauthorized',
    code: result.error.code,
    message: result.error.message,
  });
  return null;
}

/**
 * A profile is "complete" once the three required top-level sections of
 * `profile.v1.json` are present. Consent is intentionally excluded — the
 * applicant can update consent independently.
 */
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
