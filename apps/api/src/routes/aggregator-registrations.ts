/**
 * Aggregator registration endpoints.
 *
 * Public submission flow:
 *   1. Validate body against `registration.v1.json`.
 *   2. Generate `org_slug = slugify(association) + '-' + random(2 bytes)`.
 *   3. Insert an `aggregators` row to obtain the canonical Postgres UUID.
 *   4. Insert an empty `aggregator_profiles` row referencing that UUID.
 *   5. Create a Keycloak user (`enabled=false`) carrying the aggregator UUID
 *      as a user attribute (reverse pointer; Postgres holds no Keycloak id).
 *   6. Mint a signed approval JWT (1h TTL) and email the configured admins
 *      with approve / reject deep links.
 *   7. On any post-DB failure, roll back the aggregator row (cascade clears
 *      the profile via FK).
 *
 * Failures throw `httpError(<CODE>)`; the global error handler emits the
 * canonical envelope and structured log line.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getRegistrationValidator } from '../services/registration-validator.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorProfileStore } from '../services/aggregator-profile-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { getMailer } from '../services/mailer/index.js';
import { mintApprovalToken } from '../services/approval-token.js';
import { renderAdminReview } from '../services/email-templates/index.js';
import { normalisePhone } from '../services/phone.js';
import { slugWithSuffix } from '../services/slug.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
import type { AggregatorType } from '../db/schema-types.js';
import { httpError } from '../errors/http-error.js';

const SubmitBodySchema = z.object({
  aggregator_type: z.enum(['seeker', 'provider']),
  association: z.string().min(1).max(200),
  email: z.string().email().max(320),
  phone: z.string().min(7).max(20),
});

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

      const parseResult = SubmitBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Request body failed shape validation.',
          fields: { issues: parseResult.error.issues },
        });
      }

      // JSON Schema is the authoritative contract — keeps the form rules in
      // `config/` rather than code.
      const validate = getRegistrationValidator();
      if (!validate(parseResult.data)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Payload failed schema validation.',
          fields: { issues: validate.errors ?? [] },
        });
      }

      const body = parseResult.data;
      const phoneResult = normalisePhone(body.phone);
      if (!phoneResult.ok) {
        throw httpError('INVALID_PHONE', {
          detail: phoneResult.error.message,
          fields: { input: body.phone },
        });
      }

      const aggregatorType = body.aggregator_type as AggregatorType;
      const aggregatorStore = getAggregatorStore();
      const profileStore = getAggregatorProfileStore();
      const idp = getIdpAdmin();
      const mailer = getMailer();

      // Pre-check email uniqueness in Keycloak so we don't insert an orphan
      // aggregator row for a duplicate submission.
      const existing = await idp.findByEmail(body.email);
      if (!existing.ok) {
        throw httpError('IDP_UNAVAILABLE', {
          cause: existing.error,
          fields: { sub_operation: 'idp.findByEmail' },
        });
      }
      if (existing.value !== null) {
        throw httpError('USER_EXISTS', { fields: { email: body.email } });
      }

      // Phone is the OTP-login identity for the portal — Keycloak's OTP
      // authenticator looks users up by the `phoneNumber` attribute. If two
      // users share the same number, the authenticator picks the first
      // match deterministically, which can route a login attempt to a
      // disabled (pending or rejected) account and surface "account
      // disabled". Enforce phone uniqueness here so that never happens.
      const phoneOwner = await idp.findByAttribute(KC_ATTR.PHONE_NUMBER, phoneResult.value);
      if (!phoneOwner.ok) {
        throw httpError('IDP_UNAVAILABLE', {
          cause: phoneOwner.error,
          fields: { sub_operation: 'idp.findByAttribute.phoneNumber' },
        });
      }
      if (phoneOwner.value !== null) {
        throw httpError('PHONE_EXISTS', { fields: { phone: phoneResult.value } });
      }

      const aggregator = await createAggregatorWithSlug(
        aggregatorStore,
        body.association,
        aggregatorType,
      );
      if (!aggregator.ok) {
        const code =
          aggregator.error.code === 'DUPLICATE_SLUG' ? 'DUPLICATE_SLUG' : 'DB_UNAVAILABLE';
        throw httpError(code, { cause: aggregator.error });
      }
      const { id: aggregatorId, orgSlug } = aggregator.value;

      const profile = await profileStore.create({
        aggregatorId,
        schemaVersion: 1,
        data: {},
        consent: {},
        createdBy: 'self',
        updatedBy: 'self',
      });
      if (!profile.ok) {
        await aggregatorStore.deleteById(aggregatorId);
        throw httpError('DB_UNAVAILABLE', {
          cause: profile.error,
          fields: { sub_operation: 'profileStore.create', rolled_back: true },
        });
      }

      const kcAttributes: Record<string, string> = {
        [KC_ATTR.AGGREGATOR_ID]: aggregatorId,
        [KC_ATTR.ORG_SLUG]: orgSlug,
        [KC_ATTR.AGGREGATOR_TYPE]: aggregatorType,
        [KC_ATTR.ASSOCIATION]: body.association,
      };

      const kcResult = await idp.createUser({
        email: body.email,
        username: body.email,
        phone: phoneResult.value,
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
            fields: { email: body.email, rolled_back: true },
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
        applicantName: body.association,
        applicantEmail: body.email,
        applicantPhone: phoneResult.value,
        association: body.association,
        aggregatorType,
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
        message: 'Registration submitted. You will receive credentials by email after approval.',
      });
    },
  );
}

async function createAggregatorWithSlug(
  store: ReturnType<typeof getAggregatorStore>,
  association: string,
  type: AggregatorType,
): ReturnType<typeof store.create> {
  let last: Awaited<ReturnType<typeof store.create>> | null = null;
  for (let attempt = 0; attempt < SLUG_RETRIES; attempt += 1) {
    const orgSlug = slugWithSuffix(association);
    last = await store.create({ orgSlug, type });
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

function parseAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? '';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ['admin@bluedots.local'];
}
