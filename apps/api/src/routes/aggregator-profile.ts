/**
 * Aggregator profile endpoints (post-login).
 *
 *   GET /v1/aggregators/profile/me
 *     Returns the `aggregators` row (registration-essential fields) plus an
 *     identity fragment derived from JWT / Keycloak.
 *
 *   PATCH /v1/aggregators/profile/me
 *     Splits writes by destination:
 *
 *       body.aggregator.contact    → Keycloak FIRST (mirror is authoritative
 *                                    for phone+email), then DB
 *       body.aggregator.*          → DB only (name / url / locations / consent)
 *
 *     `org_slug` is rejected (immutable; DB trigger enforces too).
 *
 * The 1:1 `aggregator_profile` table this pair used to merge in was removed —
 * it was only ever written as an all-defaults stub, and its extensibility goal
 * is served by `aggregators.profile` + `aggregators.profile_ref` (migration
 * 0018). Its six response keys (`contact_name`, `personas`, `services`,
 * `verified_certificate`, `profile_completed_at`, `is_complete`) and the
 * `body.profile` request half went with it.
 *
 * Authorisation: Bearer access token from Keycloak with the custom
 * `aggregator_id` claim mapped from the user attribute.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConsentRecordSchema } from '@aggregator-dpg/shared-primitives/aggregator';
import type { BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { BecknContactSchema, BecknLocationSchema } from '@aggregator-dpg/shared-primitives/beckn';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpUser } from '../services/idp-admin/index.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

// ─── Body schemas ───────────────────────────────────────────────────────────

const AggregatorPatchSchema = z
  .object({
    name: z.string().min(2).max(200).optional(),
    url: z.string().url().max(2048).nullable().optional(),
    contact: BecknContactSchema.optional(),
    locations: z.array(BecknLocationSchema).optional(),
    consent: ConsentRecordSchema.optional(),
  })
  .strict();

const ProfileUpdateBodySchema = z
  .object({
    aggregator: AggregatorPatchSchema,
  })
  .strict();

// ─── Response schemas (OpenAPI) ─────────────────────────────────────────────

const ProfileIdentitySchema = z
  .object({
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    email: z.string().nullable(),
    email_verified: z.boolean(),
    phone: z.string().nullable(),
    phone_verified: z.boolean(),
    active: z.boolean(),
  })
  .passthrough();

// PII response sub-objects are declared with the canonical entity schemas
// (the same ones the writes are validated against) rather than empty
// `z.object({}).passthrough()`. This (a) field-whitelists the serialized
// PII so undeclared keys can never leak, and (b) renders the real shapes in
// the Scalar reference instead of empty objects.
const ProfileCommonResponseShape = {
  aggregator_id: z.string(),
  org_slug: z.string(),
  actor_type: z.string(),
  type: z.string().nullable(),
  url: z.string().nullable(),
  contact: BecknContactSchema,
  locations: z.array(BecknLocationSchema),
  consent: ConsentRecordSchema,
  status: z.string(),
  updated_at: z.string(),
};

const ProfileReadResponseSchema = z
  .object({
    ...ProfileCommonResponseShape,
    org_name: z.string(),
    identity: ProfileIdentitySchema,
    created_at: z.string(),
  })
  .passthrough();

const ProfileUpdateResponseSchema = z
  .object({
    ...ProfileCommonResponseShape,
    name: z.string(),
  })
  .passthrough();

export function registerAggregatorProfileRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/aggregators/profile/me',
    {
      schema: {
        tags: ['aggregator-profile'],
        summary: 'Read the caller aggregator profile',
        description:
          'Returns the full aggregator row + brand + contact + status for the aggregator bound to the Bearer token claim.',
        security: [{ bearerAuth: [] }],
        response: {
          200: ProfileReadResponseSchema,
          ...errorResponses(401, 403, 404, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({ operation: 'aggregator-profile.read', actor: auth.userId });
      const start = Date.now();

      const aggregatorStore = getAggregatorStore();

      const aggregator = await aggregatorStore.findById(auth.aggregatorId);
      if (!aggregator.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(aggregator.error.message) });
      }
      if (!aggregator.value) {
        throw httpError('NOT_FOUND', { detail: 'Aggregator record not found.' });
      }

      const kcUser = await fetchKcUserSafe(auth, log);

      log.info(
        { status: 'success', latency_ms: Date.now() - start, aggregator_id: auth.aggregatorId },
        'profile read',
      );

      return reply.send({
        aggregator_id: auth.aggregatorId,
        org_slug: aggregator.value.orgSlug,
        // aggregator.name is now authoritative for display. Fall back to slug
        // only on the (impossible) empty-string edge case.
        org_name: aggregator.value.name || aggregator.value.orgSlug,
        actor_type: aggregator.value.actorType,
        type: aggregator.value.type,
        url: aggregator.value.url,
        contact: aggregator.value.contact,
        locations: aggregator.value.locations,
        consent: aggregator.value.consent,
        status: aggregator.value.status,
        // Identity (from JWT claim / KC fallback)
        identity: {
          first_name: auth.firstName ?? kcUser?.firstName ?? null,
          last_name: auth.lastName ?? kcUser?.lastName ?? null,
          email: auth.email ?? kcUser?.email ?? aggregator.value.contact.email,
          email_verified: auth.emailVerified ?? false,
          phone:
            auth.phoneNumber ??
            pickAttribute(kcUser, KC_ATTR.PHONE_NUMBER) ??
            aggregator.value.contact.phone,
          phone_verified:
            auth.phoneNumberVerified ?? pickAttribute(kcUser, 'phoneNumberVerified') === 'true',
          active: kcUser?.enabled ?? aggregator.value.status === 'active',
        },
        created_at: aggregator.value.createdAt.toISOString(),
        updated_at: aggregator.value.updatedAt.toISOString(),
      });
    },
  );

  app.patch(
    '/v1/aggregators/profile/me',
    {
      schema: {
        tags: ['aggregator-profile'],
        summary: 'Update the caller aggregator profile',
        description:
          'Partial update of the caller aggregator (name / url / contact / locations / consent). Contact phone + email are mirrored to Keycloak before the DB write.',
        security: [{ bearerAuth: [] }],
        body: ProfileUpdateBodySchema,
        response: {
          200: ProfileUpdateResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({ operation: 'aggregator-profile.update', actor: auth.userId });
      const start = Date.now();

      // `schema.body` already validated against `ProfileUpdateBodySchema`
      // (the zod validator compiler replaces `req.body` with the parse
      // output), so the typed body can be consumed directly here.
      const body = req.body as z.infer<typeof ProfileUpdateBodySchema>;

      const aggregatorStore = getAggregatorStore();

      // ─── 1. Mirror phone/email to Keycloak FIRST (authoritative). ──────────
      // If KC fails, abort before touching the DB so we never have the DB
      // ahead of Keycloak.
      let normalisedContact: BecknContact | undefined;
      if (body.aggregator.contact) {
        const raw = body.aggregator.contact;
        const phoneR = normalisePhone(raw.phone);
        if (!phoneR.ok) {
          throw httpError('INVALID_PHONE', {
            detail: phoneR.error.message,
            // Key it `phone` (not `input`) so the logger's `*.phone` redact
            // path masks the raw number if this error is ever logged.
            fields: { phone: raw.phone },
          });
        }
        normalisedContact = { ...raw, phone: phoneR.value };

        const idp = getIdpAdmin();
        const kcWrite = await idp.setAttributes(auth.userId, {
          [KC_ATTR.PHONE_NUMBER]: phoneR.value,
        });
        if (!kcWrite.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'idp.setAttributes.contact',
              code: kcWrite.error.code,
              cause: kcWrite.error.message,
            },
            'failed to mirror phone to Keycloak — aborting before DB write',
          );
          throw httpError('IDP_UNAVAILABLE', { cause: kcWrite.error });
        }
      }

      // ─── 2. Aggregator-table updates ──────────────────────────────────────
      const patch: Parameters<typeof aggregatorStore.update>[1] = {
        updatedBy: auth.userId,
      };
      if (body.aggregator.name !== undefined) patch.name = body.aggregator.name;
      if (body.aggregator.url !== undefined) patch.url = body.aggregator.url;
      if (normalisedContact !== undefined) patch.contact = normalisedContact;
      if (body.aggregator.locations !== undefined) patch.locations = body.aggregator.locations;
      if (body.aggregator.consent !== undefined) patch.consent = body.aggregator.consent;

      const result = await aggregatorStore.update(auth.aggregatorId, patch);
      if (!result.ok) {
        throw httpError(mapAggregatorUpdateError(result.error.code), {
          cause: new Error(result.error.message),
        });
      }

      log.info(
        {
          status: 'success',
          latency_ms: Date.now() - start,
          aggregator_id: auth.aggregatorId,
        },
        'profile updated',
      );

      // Echo the post-write row so the client doesn't need an extra GET.
      const aggregator = await aggregatorStore.findById(auth.aggregatorId);
      if (!aggregator.ok || !aggregator.value) {
        throw httpError('INTERNAL', { detail: 'Post-write read failed.' });
      }

      return reply.send({
        aggregator_id: auth.aggregatorId,
        org_slug: aggregator.value.orgSlug,
        name: aggregator.value.name,
        actor_type: aggregator.value.actorType,
        type: aggregator.value.type,
        url: aggregator.value.url,
        contact: aggregator.value.contact,
        locations: aggregator.value.locations,
        consent: aggregator.value.consent,
        status: aggregator.value.status,
        updated_at: aggregator.value.updatedAt.toISOString(),
      });
    },
  );
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

function mapAggregatorUpdateError(
  code:
    | 'NOT_FOUND'
    | 'DUPLICATE_SLUG'
    | 'DUPLICATE_PHONE'
    | 'DUPLICATE_EMAIL'
    | 'DUPLICATE'
    | 'CHECK_VIOLATION'
    | 'DB_UNAVAILABLE',
): Parameters<typeof httpError>[0] {
  switch (code) {
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'DUPLICATE_PHONE':
      return 'PHONE_EXISTS';
    case 'DUPLICATE_EMAIL':
      return 'USER_EXISTS';
    case 'CHECK_VIOLATION':
      return 'SCHEMA_VALIDATION';
    case 'DUPLICATE_SLUG':
      return 'DUPLICATE_SLUG';
    // An unrecognised unique violation is a real conflict, but not one this
    // layer can name — don't dress it up as a taken slug (#718 review).
    case 'DUPLICATE':
      return 'CONFLICT';
    default:
      return 'DB_UNAVAILABLE';
  }
}
