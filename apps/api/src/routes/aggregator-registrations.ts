/**
 * Aggregator registration endpoints.
 *
 * Public submission flow:
 *   1. Validate body against `RegistrationPayloadSchema` (Zod) AND
 *      `registration.v1.json` (Ajv). The JSON Schema is the authoritative
 *      contract that drives the UI form; Zod gives type-safe parsing.
 *   2. Normalise `contact.phone` to E.164.
 *   3. Pre-check email + phone uniqueness in BOTH the DB and Keycloak. The
 *      DB has its own UNIQUE indexes (`contact_phone`, `contact_email`),
 *      but checking up-front avoids inserting an orphan aggregator row
 *      that then has to be rolled back.
 *   4. Generate `org_slug = slugFromName(body.name)` with retry on the
 *      (statistically tiny) suffix collision.
 *   5. INSERT `aggregators` (status='pending', actor_type='aggregator',
 *      type=null) and INSERT a stub `aggregator_profile` row alongside.
 *      If the profile insert fails, delete the aggregator (cascade clears
 *      anything that managed to land).
 *   6. Create the Keycloak user with attributes
 *      { aggregator_id, aggregator_type, phoneNumber, decision_made: 'pending' }.
 *      Email is a built-in field. The user is created disabled — login is
 *      blocked until the admin approval flow flips `decision_made → approved`
 *      and enables the KC user. `aggregator_type` (seeker | provider) is
 *      published as a JWT claim and drives the single-type enforcement on
 *      bulk uploads and public registration links.
 *   7. Mint approve / reject JWTs and email the configured admins.
 *
 * Failures throw `httpError(<CODE>)`. KC failure post-DB → rollback the
 * aggregator row (FK cascades the profile).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RegistrationPayloadSchema } from '@aggregator-dpg/shared-primitives/aggregator';
import type { BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { getRegistrationValidator } from '../services/registration-validator.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorProfileStore } from '../services/aggregator-profile-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { sendAdminReviewEmail } from '../services/registration-notify.js';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { normalisePhone } from '../services/phone.js';
import { slugFromName } from '../services/slug.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import type { ErrorCode } from '../errors/codes.js';

const SLUG_RETRIES = 3;

const RegistrationCreatedResponseSchema = z
  .object({
    aggregator_id: z.string(),
    org_slug: z.string(),
    status: z.string(),
    message: z.string(),
  })
  .passthrough();

export async function registerAggregatorRegistrationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/aggregator-registrations/create',
    {
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Submit a new aggregator registration',
        description:
          'Validates submission against config/schemas/aggregator/registration.v1.json, creates a disabled user (login enabled on admin approval), and pushes the org to signalstack. Reached via a non-aggregator Bearer token from Keycloak.',
        body: RegistrationPayloadSchema,
        response: {
          201: RegistrationCreatedResponseSchema,
          ...errorResponses(400, 401, 409, 500, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'aggregator-registration.create' });
      const start = Date.now();

      // Every backend API requires a Bearer token. Registration is reached
      // anonymously by the user, so the BFF attaches a Keycloak service-
      // account token (client_credentials grant on the `aggregator-bff`
      // confidential client). `authenticateAny` only checks the JWT
      // signature + issuer/exp; it does not require an `aggregator_id`
      // claim because the caller is a service principal, not a user.
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', {
          detail: auth.error.message,
          fields: { reason: auth.error.code },
        });
      }

      // `schema.body` already validated against `RegistrationPayloadSchema`
      // (the zod validator compiler replaces `req.body` with the parse
      // output), so the typed body can be consumed directly here.
      const body = req.body as z.infer<typeof RegistrationPayloadSchema>;

      // JSON Schema is the authoritative contract — keeps the form rules in
      // `config/` rather than code.
      const validate = await getRegistrationValidator();
      if (!validate(req.body)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Payload failed JSON Schema validation.',
          fields: { issues: validate.errors ?? [] },
        });
      }
      const phoneResult = normalisePhone(body.contact.phone);
      if (!phoneResult.ok) {
        throw httpError('INVALID_PHONE', {
          detail: phoneResult.error.message,
          fields: { input: body.contact.phone },
        });
      }
      const phoneE164 = phoneResult.value;
      // Persist the normalised E.164 representation so DB queries + Keycloak
      // attribute reads agree on a single canonical form.
      const contact: BecknContact = {
        ...body.contact,
        // Zod has already lowercased the email via the transform — keep it.
        phone: phoneE164,
      };

      const aggregatorStore = getAggregatorStore();
      const profileStore = getAggregatorProfileStore();
      const idp = getIdpAdmin();

      // Server-stamp the consent timestamp so the recorded value reflects
      // when the API actually accepted the registration, not whatever the
      // client clock reported. `valid_till` stays caller-supplied but is
      // clamped to a hard ceiling so a misbehaving form can not store a
      // 1000-year consent window. Computed early so it is in scope for both
      // the reclaim path and the new-registration path below.
      const serverConsent = stampConsent(body.consent);

      // Pre-check email + phone uniqueness in both stores. The DB
      // generated-column UNIQUEs (contact_phone / contact_email) and Keycloak
      // attribute lookups together give us a deterministic 409 instead of a
      // race between `aggregators` and Keycloak.
      const dbEmail = await aggregatorStore.findByContactEmail(contact.email);
      if (!dbEmail.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(dbEmail.error.message),
          fields: { sub_operation: 'aggregatorStore.findByContactEmail' },
        });
      }
      if (dbEmail.value !== null) {
        const existing = dbEmail.value;
        if (!isReclaimable(existing.status)) {
          throw httpError('USER_EXISTS', { fields: { email: contact.email } });
        }
        // Reclaim path: same applicant resubmitting against a pending/rejected
        // record (e.g. after the approval link expired). Refresh the row +
        // KC user in place and re-mint a fresh approval link.
        const dbPhone = await aggregatorStore.findByContactPhone(phoneE164);
        if (!dbPhone.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(dbPhone.error.message),
            fields: { sub_operation: 'aggregatorStore.findByContactPhone' },
          });
        }
        if (dbPhone.value !== null && dbPhone.value.id !== existing.id) {
          // The new phone belongs to a different record — genuine conflict.
          throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
        }

        const updated = await aggregatorStore.update(existing.id, {
          name: body.name,
          type: body.type,
          url: body.url ?? null,
          contact,
          locations: body.locations,
          consent: serverConsent,
          status: 'pending',
          updatedBy: 'self',
        });
        if (!updated.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(updated.error.message),
            fields: { sub_operation: 'aggregatorStore.update', reclaim: true },
          });
        }

        // Reuse the existing (still-disabled) KC user; refresh its attributes
        // and reset the decision gate to pending. Recreate it only if drift
        // left the DB row without a matching KC user.
        const kcExisting = await idp.findByEmail(contact.email);
        if (!kcExisting.ok) {
          throw httpError('IDP_UNAVAILABLE', {
            cause: kcExisting.error,
            fields: { sub_operation: 'idp.findByEmail', reclaim: true },
          });
        }
        if (kcExisting.value !== null) {
          const kcId = kcExisting.value.id;
          await idp.setAttributes(kcId, {
            [KC_ATTR.AGGREGATOR_TYPE]: body.type,
            [KC_ATTR.PHONE_NUMBER]: phoneE164,
          });
          await idp.setUserDecision(kcId, 'pending');
          await idp.disableUser(kcId);
        } else {
          const { firstName, lastName } = splitName(contact.name);
          const recreated = await idp.createUser({
            email: contact.email,
            username: contact.email,
            phone: phoneE164,
            enabled: false,
            firstName,
            lastName,
            attributes: {
              [KC_ATTR.AGGREGATOR_ID]: existing.id,
              [KC_ATTR.AGGREGATOR_TYPE]: body.type,
              [KC_ATTR.PHONE_NUMBER]: phoneE164,
              [KC_ATTR.DECISION_MADE]: 'pending',
            },
          });
          if (!recreated.ok) {
            throw httpError('IDP_UNAVAILABLE', {
              cause: recreated.error,
              fields: { sub_operation: 'idp.createUser', reclaim: true },
            });
          }
        }

        await sendAdminReviewEmail(
          {
            aggregatorId: existing.id,
            applicantName: body.name,
            applicantEmail: contact.email,
            applicantPhone: phoneE164,
          },
          log,
        );

        log.info(
          {
            status: 'success',
            latency_ms: Date.now() - start,
            aggregator_id: existing.id,
            reclaim: true,
          },
          'aggregator registration resubmitted (reclaimed pending record)',
        );

        return reply.status(200).send({
          aggregator_id: existing.id,
          org_slug: existing.orgSlug,
          status: 'pending',
          message: 'Registration re-submitted. A fresh approval link has been sent for review.',
        });
      }

      const dbPhone = await aggregatorStore.findByContactPhone(phoneE164);
      if (!dbPhone.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(dbPhone.error.message),
          fields: { sub_operation: 'aggregatorStore.findByContactPhone' },
        });
      }
      if (dbPhone.value !== null) {
        throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
      }

      const kcEmail = await idp.findByEmail(contact.email);
      if (!kcEmail.ok) {
        throw httpError('IDP_UNAVAILABLE', {
          cause: kcEmail.error,
          fields: { sub_operation: 'idp.findByEmail' },
        });
      }
      if (kcEmail.value !== null) {
        throw httpError('USER_EXISTS', { fields: { email: contact.email } });
      }

      // Phone is the OTP-login identity for the portal — Keycloak's OTP
      // authenticator looks users up by the `phoneNumber` attribute. If two
      // users share the same number, the authenticator picks the first
      // match deterministically, which can route a login attempt to a
      // disabled (pending or rejected) account and surface "account
      // disabled". Enforce phone uniqueness here so that never happens.
      const kcPhone = await idp.findByAttribute(KC_ATTR.PHONE_NUMBER, phoneE164);
      if (!kcPhone.ok) {
        throw httpError('IDP_UNAVAILABLE', {
          cause: kcPhone.error,
          fields: { sub_operation: 'idp.findByAttribute.phoneNumber' },
        });
      }
      if (kcPhone.value !== null) {
        throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
      }

      const aggregator = await createAggregatorWithSlug(aggregatorStore, body.name, {
        type: body.type,
        url: body.url ?? null,
        contact,
        locations: body.locations,
        consent: serverConsent,
      });
      if (!aggregator.ok) {
        const code = mapStoreCreateError(aggregator.error.code);
        throw httpError(code, { cause: new Error(aggregator.error.message) });
      }
      const { id: aggregatorId, orgSlug } = aggregator.value;

      const profile = await profileStore.create({
        aggregatorId,
        createdBy: 'self',
        updatedBy: 'self',
      });
      if (!profile.ok) {
        await aggregatorStore.deleteById(aggregatorId);
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(profile.error.message),
          fields: { sub_operation: 'profileStore.create', rolled_back: true },
        });
      }

      // Keycloak carries four attributes:
      //   - aggregator_id    reverse pointer to Postgres
      //   - aggregator_type  participant focus, used by single-type enforcement
      //   - phoneNumber      OTP login authenticator
      //   - decision_made    login gate
      // Slug, association, and decision metadata live in Postgres.
      const kcAttributes: Record<string, string> = {
        [KC_ATTR.AGGREGATOR_ID]: aggregatorId,
        [KC_ATTR.AGGREGATOR_TYPE]: body.type,
        [KC_ATTR.PHONE_NUMBER]: phoneE164,
        [KC_ATTR.DECISION_MADE]: 'pending',
      };

      // Split the Beckn `contact.name` into first / last for Keycloak. The
      // signup form already collects the full name, so we don't ask for it
      // again via an UPDATE_PROFILE required action on first login.
      const { firstName, lastName } = splitName(contact.name);
      const kcResult = await idp.createUser({
        email: contact.email,
        username: contact.email,
        phone: phoneE164,
        enabled: false,
        firstName,
        lastName,
        attributes: kcAttributes,
      });
      if (!kcResult.ok) {
        await aggregatorStore.deleteById(aggregatorId);
        if (kcResult.error.code === 'USER_EXISTS') {
          throw httpError('USER_EXISTS', {
            cause: kcResult.error,
            fields: { email: contact.email, rolled_back: true },
          });
        }
        throw httpError('IDP_UNAVAILABLE', {
          cause: kcResult.error,
          fields: { sub_operation: 'idp.createUser', rolled_back: true },
        });
      }

      await sendAdminReviewEmail(
        {
          aggregatorId,
          applicantName: body.name,
          applicantEmail: contact.email,
          applicantPhone: phoneE164,
        },
        log,
      );

      log.info(
        {
          status: 'success',
          latency_ms: Date.now() - start,
          aggregator_id: aggregatorId,
          org_slug: orgSlug,
          keycloak_user_id: kcResult.value.id,
        },
        'aggregator registration submitted',
      );

      return reply.status(201).send({
        aggregator_id: aggregatorId,
        org_slug: orgSlug,
        status: 'pending',
        message: 'Registration submitted. You will receive credentials by email after approval.',
      });
    },
  );
}

/**
 * Insert an aggregator with up to {@link SLUG_RETRIES} attempts. The
 * 4-hex-char random suffix on `slugFromName` makes collisions astronomically
 * unlikely, but retrying on `DUPLICATE_SLUG` makes the path robust against
 * the (also vanishingly rare) random-suffix collision.
 */
async function createAggregatorWithSlug(
  store: ReturnType<typeof getAggregatorStore>,
  name: string,
  extras: {
    type: ReturnType<typeof RegistrationPayloadSchema.parse>['type'];
    url: string | null;
    contact: BecknContact;
    locations: ReturnType<typeof RegistrationPayloadSchema.parse>['locations'];
    consent: ReturnType<typeof RegistrationPayloadSchema.parse>['consent'];
  },
): ReturnType<typeof store.create> {
  let last: Awaited<ReturnType<typeof store.create>> | null = null;
  for (let attempt = 0; attempt < SLUG_RETRIES; attempt += 1) {
    const orgSlug = slugFromName(name);
    last = await store.create({
      orgSlug,
      actorType: 'aggregator',
      name,
      type: extras.type,
      url: extras.url,
      contact: extras.contact,
      locations: extras.locations,
      consent: extras.consent,
      createdBy: 'self',
      updatedBy: 'self',
    });
    if (last.ok) return last;
    if (last.error.code !== 'DUPLICATE_SLUG') return last;
  }
  return (
    last ?? {
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'slug retries exhausted' },
    }
  );
}

/**
 * Maximum consent validity window. Hard ceiling so a buggy or hostile
 * client cannot persist a consent record that is effectively permanent.
 * Five years lines up with typical regulatory retention envelopes; tune
 * via config if a deployment needs something different.
 */
const MAX_CONSENT_VALIDITY_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/**
 * Server-stamp `given_at` to the current instant and clamp `valid_till` to
 * at most {@link MAX_CONSENT_VALIDITY_MS} after that instant. The client is
 * allowed to ask for a shorter window but never a longer one.
 *
 * @param incoming - Consent block as it arrived from the registration form.
 * @returns Consent record with server-authoritative timestamps.
 */
function stampConsent(
  incoming: ReturnType<typeof RegistrationPayloadSchema.parse>['consent'],
): ReturnType<typeof RegistrationPayloadSchema.parse>['consent'] {
  const now = new Date();
  const maxValidTill = new Date(now.getTime() + MAX_CONSENT_VALIDITY_MS);
  const requestedValidTill = new Date(incoming.valid_till);
  const validTill =
    Number.isFinite(requestedValidTill.getTime()) && requestedValidTill < maxValidTill
      ? requestedValidTill
      : maxValidTill;
  return {
    ...incoming,
    given_at: now.toISOString(),
    valid_till: validTill.toISOString(),
  };
}

function mapStoreCreateError(
  code:
    | 'NOT_FOUND'
    | 'DUPLICATE_SLUG'
    | 'DUPLICATE_PHONE'
    | 'DUPLICATE_EMAIL'
    | 'CHECK_VIOLATION'
    | 'DB_UNAVAILABLE',
): ErrorCode {
  switch (code) {
    case 'DUPLICATE_SLUG':
      return 'DUPLICATE_SLUG';
    case 'DUPLICATE_PHONE':
      return 'PHONE_EXISTS';
    case 'DUPLICATE_EMAIL':
      return 'USER_EXISTS';
    case 'CHECK_VIOLATION':
      return 'SCHEMA_VALIDATION';
    default:
      return 'DB_UNAVAILABLE';
  }
}

/**
 * Split a single-line contact name into Keycloak's first / last fields.
 * Everything before the first whitespace is the first name; everything after
 * is the last name. Single-token inputs (e.g. "Asha") produce an empty last
 * name — Keycloak accepts that.
 */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const firstSpace = trimmed.search(/\s+/);
  if (firstSpace === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.slice(0, firstSpace),
    lastName: trimmed.slice(firstSpace).trim(),
  };
}

/**
 * Whether an existing registration in this status may be reclaimed by a
 * resubmission. `pending` (awaiting a decision) and `inactive` (rejected)
 * records belong to the same applicant and are refreshed in place; `active`
 * and `retired` are live identities and must keep returning a duplicate error.
 *
 * @param status - The matched aggregator's lifecycle status.
 * @returns `true` when a resubmit should refresh rather than 409.
 */
export function isReclaimable(status: AggregatorStatus): boolean {
  return status === 'pending' || status === 'inactive';
}

// Re-export so existing tests that import { z } from this module still resolve.
export { z };
