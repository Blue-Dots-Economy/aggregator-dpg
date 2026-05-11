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
 *      { aggregator_id, phoneNumber, decision_made: 'pending' }. Email is
 *      a built-in field. The user is created disabled — login is blocked
 *      until the admin approval flow flips `decision_made → approved` and
 *      enables the KC user.
 *   7. Mint approve / reject JWTs and email the configured admins.
 *
 * Failures throw `httpError(<CODE>)`. KC failure post-DB → rollback the
 * aggregator row (FK cascades the profile).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RegistrationPayloadSchema } from '@aggregator-dpg/shared-primitives/aggregator';
import type { BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { config } from '../config.js';
import { getRegistrationValidator } from '../services/registration-validator.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorProfileStore } from '../services/aggregator-profile-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { getMailer } from '../services/mailer/index.js';
import { mintApprovalToken } from '../services/approval-token.js';
import { renderAdminReview } from '../services/email-templates/index.js';
import { normalisePhone } from '../services/phone.js';
import { slugFromName } from '../services/slug.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
import { httpError } from '../errors/http-error.js';
import type { ErrorCode } from '../errors/codes.js';

const SLUG_RETRIES = 3;

export async function registerAggregatorRegistrationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/aggregator-registrations/create',
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

      const parseResult = RegistrationPayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Request body failed shape validation.',
          fields: { issues: parseResult.error.issues },
        });
      }

      // JSON Schema is the authoritative contract — keeps the form rules in
      // `config/` rather than code.
      const validate = getRegistrationValidator();
      if (!validate(req.body)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Payload failed JSON Schema validation.',
          fields: { issues: validate.errors ?? [] },
        });
      }

      const body = parseResult.data;
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
      const mailer = getMailer();

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
        throw httpError('USER_EXISTS', { fields: { email: contact.email } });
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
        consent: body.consent,
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

      // Keycloak gets ONLY the three attributes we promised it would carry:
      // aggregator_id, phoneNumber, decision_made. Slug, association, and
      // aggregator_type live in Postgres — KC is auth, not metadata.
      const kcAttributes: Record<string, string> = {
        [KC_ATTR.AGGREGATOR_ID]: aggregatorId,
        [KC_ATTR.PHONE_NUMBER]: phoneE164,
        [KC_ATTR.DECISION_MADE]: 'pending',
      };

      const kcResult = await idp.createUser({
        email: contact.email,
        username: contact.email,
        phone: phoneE164,
        enabled: false,
        // Defer first/last name to the first login. Keycloak's
        // UPDATE_PROFILE required action drives the prompt — the realm's
        // user-profile config controls which fields appear and whether
        // they are mandatory.
        requiredActions: ['UPDATE_PROFILE'],
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

      // Mint approval JWTs (separate token per intent so the URL itself is
      // self-describing — admin's email client previews show distinct links).
      let approveToken: string;
      let rejectToken: string;
      try {
        approveToken = (await mintApprovalToken({ aggregatorId, intent: 'approve' })).token;
        rejectToken = (await mintApprovalToken({ aggregatorId, intent: 'reject' })).token;
      } catch (err) {
        // KC user remains disabled + orphaned-but-known. Don't roll back —
        // the admin can still trigger an action manually.
        throw httpError('TOKEN_MINT_FAILED', { cause: err });
      }

      const recipients = parseAdminEmails();
      const decisionBase = `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/read/${aggregatorId}`;
      const reviewMail = renderAdminReview({
        registrationId: aggregatorId,
        applicantName: body.name,
        applicantEmail: contact.email,
        applicantPhone: phoneE164,
        association: body.name,
        aggregatorType: 'aggregator',
        approveUrl: `${decisionBase}?token=${encodeURIComponent(approveToken)}&intent=approve`,
        rejectUrl: `${decisionBase}?token=${encodeURIComponent(rejectToken)}&intent=reject`,
        submittedAt: new Date(),
      });
      const mailResult = await mailer.send({
        to: recipients,
        subject: reviewMail.subject,
        html: reviewMail.html,
        text: reviewMail.text,
      });
      if (!mailResult.ok) {
        // Email failure is logged but not surfaced as a 5xx — the row is
        // still authoritative and admins can resend.
        log.warn(
          {
            sub_operation: 'mailer.send',
            code: mailResult.error.code,
            cause: mailResult.error.message,
          },
          'admin review email delivery failed — registration still recorded',
        );
      }

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

function parseAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? '';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ['admin@bluedots.local'];
}

// Re-export so existing tests that import { z } from this module still resolve.
export { z };
