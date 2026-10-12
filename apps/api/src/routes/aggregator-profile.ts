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
 *       body.aggregator.*          → DB only (name)
 *
 *     Org details (`url`, `locations`, `contact.company`, `contact.gstNumber`)
 *     belong to the coordinator's org since migration 0028: they are rendered
 *     from it on GET, and a PATCH carrying any of them is refused with
 *     `409 ORG_DETAILS_READ_ONLY` before anything is written.
 *
 *     `consent` is read-only: it is recorded once, at registration, in the
 *     append-only consent ledger, and a coordinator cannot rewrite it. A body
 *     that sends it is refused as `SCHEMA_VALIDATION` (the schema is strict).
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
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
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
  })
  // Consent is read-only after registration (#836; since 0029 it lives only in
  // the consent ledger): a body carrying it is refused, 400 SCHEMA_VALIDATION.
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
  // The newest registration consent from the ledger; null only when the
  // ledger holds none (never after the 0029 verify).
  consent: ConsentRecordSchema.nullable(),
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
          "Partial update of the caller aggregator (name / contact). Consent is read-only after registration: a body carrying `consent` is refused with 400 SCHEMA_VALIDATION. Contact phone + email are mirrored to Keycloak before the DB write. Org details (url, locations, contact.company, contact.gstNumber) belong to the coordinator's organisation and are refused with 409 ORG_DETAILS_READ_ONLY.",
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

      // Org details are shared by every coordinator of the org: a CHANGE to any
      // of them is refused before any write (Keycloak or DB). Sending back the
      // values GET returned (a client echoing its own contact) is not a change.
      const sentOrgDetails =
        body.aggregator.url !== undefined ||
        body.aggregator.locations !== undefined ||
        body.aggregator.contact?.company !== undefined ||
        body.aggregator.contact?.gstNumber !== undefined;
      if (sentOrgDetails) {
        const current = await aggregatorStore.findById(auth.aggregatorId);
        if (!current.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(current.error.message),
            fields: { sub_operation: 'aggregatorStore.findById' },
          });
        }
        const now = current.value;
        const same = (a: unknown, b: unknown) =>
          JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const changed = [
          ...(body.aggregator.url !== undefined && !same(body.aggregator.url, now?.url)
            ? ['url']
            : []),
          ...(body.aggregator.locations !== undefined &&
          !same(body.aggregator.locations, now?.locations)
            ? ['locations']
            : []),
          ...(body.aggregator.contact?.company !== undefined &&
          !same(body.aggregator.contact.company, now?.contact.company)
            ? ['contact.company']
            : []),
          ...(body.aggregator.contact?.gstNumber !== undefined &&
          !same(body.aggregator.contact.gstNumber, now?.contact.gstNumber)
            ? ['contact.gstNumber']
            : []),
        ];
        if (changed.length > 0) {
          throw httpError('ORG_DETAILS_READ_ONLY', { fields: { fields: changed } });
        }
      }

      // ─── 1. Mirror phone/email to Keycloak FIRST (authoritative). ──────────
      // If KC fails, abort before touching the DB so we never have the DB
      // ahead of Keycloak.
      let normalisedContact: BecknContact | undefined;
      // The coordinator's stored phone before this request (what Keycloak
      // mirrors), written back to Keycloak if the DB write fails.
      let previousPhone: string | undefined;
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

        // One phone and one email per person across coordinators and org
        // owners (the phone is the OTP login key; `contact`, migration 0025).
        // Checked before the Keycloak write so a clash never leaves Keycloak
        // ahead of the DB.
        previousPhone = await assertContactChangeAllowed(auth.aggregatorId, {
          email: raw.email,
          phone: phoneR.value,
        });

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
      if (normalisedContact !== undefined) patch.contact = normalisedContact;

      const result = await aggregatorStore.update(auth.aggregatorId, patch);
      if (!result.ok && normalisedContact && previousPhone !== undefined) {
        // Keycloak was written first; put it back so it never runs ahead of
        // the database. Best-effort — logged if it fails.
        const revert = await getIdpAdmin().setAttributes(auth.userId, {
          [KC_ATTR.PHONE_NUMBER]: previousPhone,
        });
        if (!revert.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'idp.setAttributes.revert',
              code: revert.error.code,
            },
            'DB update failed and the Keycloak phone could not be restored',
          );
        }
      }
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
    | 'CONSENT_WRITE_FAILED'
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

/**
 * Checks a coordinator's requested contact change BEFORE anything is written
 * (Keycloak is written first, so a late refusal would leave it ahead of the
 * database):
 *   - the phone or email already belongs to another person (another
 *     coordinator, or an org owner whose contact is not this coordinator's own)
 *     → PHONE_EXISTS / USER_EXISTS;
 *   - this coordinator's contact is shared with an org-owner role (one person,
 *     two roles) and the email or phone would change → CONFLICT (not supported
 *     until accounts are modelled separately, in a later phase).
 * Identity is compared on stored contact ids, never on the submitted email.
 *
 * @param selfId - The caller's own `aggregators.id`.
 * @param next - The requested email and canonical phone.
 * @returns The coordinator's current phone (to restore Keycloak on failure).
 * @throws {HttpError} PHONE_EXISTS, USER_EXISTS, CONFLICT, NOT_FOUND or DB_UNAVAILABLE.
 */
async function assertContactChangeAllowed(
  selfId: string,
  next: { email: string; phone: string },
): Promise<string> {
  const aggregators = getAggregatorStore();
  const orgs = getAggregatorOrgStore();

  const me = valueOrUnavailable('aggregatorStore.findById', await aggregators.findById(selfId));
  if (!me) throw httpError('NOT_FOUND');
  const email = next.email.trim().toLowerCase();
  const phoneClash = () => httpError('PHONE_EXISTS', { fields: { phone: next.phone } });
  const emailClash = () => httpError('USER_EXISTS', { fields: { email: next.email } });
  /** Another person: a coordinator row that is not the caller's own. */
  const otherCoordinator = (a: { id: string } | null): boolean => !!a && a.id !== selfId;
  /** Another person: an org owner whose contact is not this coordinator's. */
  const otherOwner = (o: { contactId: string } | null): boolean =>
    !!o && o.contactId !== me.contactId;

  const byPhone = await aggregators.findByContactPhone(next.phone);
  if (otherCoordinator(valueOrUnavailable('aggregatorStore.findByContactPhone', byPhone))) {
    throw phoneClash();
  }
  const byEmail = await aggregators.findByContactEmail(email);
  if (otherCoordinator(valueOrUnavailable('aggregatorStore.findByContactEmail', byEmail))) {
    throw emailClash();
  }
  const ownerByPhone = await orgs.findByOwnerPhone(next.phone);
  if (otherOwner(valueOrUnavailable('orgStore.findByOwnerPhone', ownerByPhone))) {
    throw phoneClash();
  }
  const ownerByEmail = await orgs.findByOwnerEmail(email);
  if (otherOwner(valueOrUnavailable('orgStore.findByOwnerEmail', ownerByEmail))) {
    throw emailClash();
  }

  const identityChanges = email !== me.contactEmail || next.phone !== me.contactPhone;
  if (identityChanges) {
    const owner = valueOrUnavailable(
      'orgStore.findByOwnerEmail',
      await orgs.findByOwnerEmail(me.contactEmail),
    );
    if (owner?.contactId === me.contactId) {
      throw httpError('CONFLICT', {
        detail: 'This contact is also an organisation owner; change it through the organisation.',
      });
    }
  }
  return me.contactPhone;
}

/**
 * Unwraps a store result, turning a store failure into `503 DB_UNAVAILABLE`.
 *
 * @param op - Store operation, reported as `sub_operation`.
 * @param result - The store result.
 * @returns The result value.
 * @throws {HttpError} DB_UNAVAILABLE when the store call failed.
 */
function valueOrUnavailable<T>(
  op: string,
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(result.error.message),
      fields: { sub_operation: op },
    });
  }
  return result.value;
}
