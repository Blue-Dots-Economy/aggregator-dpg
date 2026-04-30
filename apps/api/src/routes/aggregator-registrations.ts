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
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
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
      // Every backend API requires a Bearer token. Registration is reached
      // anonymously by the user, so the BFF attaches a Keycloak service-
      // account token (client_credentials grant on the `aggregator-bff`
      // confidential client). `authenticateAny` only checks the JWT
      // signature + issuer/exp; it does not require an `aggregator_id`
      // claim because the caller is a service principal, not a user.
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        return reply.status(401).send({
          error: 'Unauthorized',
          code: auth.error.code,
          message: auth.error.message,
        });
      }

      const parseResult = SubmitBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'invalid request body',
          details: parseResult.error.issues,
        });
      }

      // JSON Schema is the authoritative contract — keeps the form rules in
      // `config/` rather than code.
      const validate = getRegistrationValidator();
      if (!validate(parseResult.data)) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: 'payload failed schema validation',
          details: validate.errors,
        });
      }

      const body = parseResult.data;
      const phoneResult = normalisePhone(body.phone);
      if (!phoneResult.ok) {
        return reply.status(400).send({
          error: 'BadRequest',
          code: 'INVALID_PHONE',
          message: phoneResult.error.message,
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
        logger.error({
          operation: 'aggregator-registration.create',
          status: 'failure',
          step: 'idp.findByEmail',
          error: existing.error.message,
          error_code: existing.error.code,
        });
        return reply.status(503).send({
          error: 'ServiceUnavailable',
          code: existing.error.code,
          message: 'identity service unavailable',
        });
      }
      if (existing.value !== null) {
        return reply.status(409).send({
          error: 'Conflict',
          code: 'USER_EXISTS',
          message: 'a user with this email is already registered',
        });
      }

      // Phone is the OTP-login identity for the portal — Keycloak's OTP
      // authenticator looks users up by the `phoneNumber` attribute. If two
      // users share the same number, the authenticator picks the first
      // match deterministically, which can route a login attempt to a
      // disabled (pending or rejected) account and surface "account
      // disabled". Enforce phone uniqueness here so that never happens.
      const phoneOwner = await idp.findByAttribute(KC_ATTR.PHONE_NUMBER, phoneResult.value);
      if (!phoneOwner.ok) {
        logger.error({
          operation: 'aggregator-registration.create',
          status: 'failure',
          step: 'idp.findByAttribute.phoneNumber',
          error: phoneOwner.error.message,
          error_code: phoneOwner.error.code,
        });
        return reply.status(503).send({
          error: 'ServiceUnavailable',
          code: phoneOwner.error.code,
          message: 'identity service unavailable',
        });
      }
      if (phoneOwner.value !== null) {
        return reply.status(409).send({
          error: 'Conflict',
          code: 'PHONE_EXISTS',
          message: 'a user with this mobile number is already registered',
        });
      }

      const aggregator = await createAggregatorWithSlug(
        aggregatorStore,
        body.association,
        aggregatorType,
      );
      if (!aggregator.ok) {
        return reply.status(503).send({
          error: 'ServiceUnavailable',
          code: aggregator.error.code,
          message: aggregator.error.message,
        });
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
        logger.error({
          operation: 'aggregator-registration.create',
          status: 'failure',
          step: 'profileStore.create',
          error: profile.error.message,
        });
        return reply.status(503).send({
          error: 'ServiceUnavailable',
          code: profile.error.code,
          message: profile.error.message,
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
        logger.error({
          operation: 'aggregator-registration.create',
          status: 'failure',
          step: 'idp.createUser',
          error: kcResult.error.message,
          error_code: kcResult.error.code,
        });
        const status = kcResult.error.code === 'USER_EXISTS' ? 409 : 503;
        return reply.status(status).send({
          error: status === 409 ? 'Conflict' : 'ServiceUnavailable',
          code: kcResult.error.code,
          message: kcResult.error.message,
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
        logger.error({
          operation: 'aggregator-registration.create',
          status: 'failure',
          step: 'mintApprovalToken',
          error: (err as Error).message,
        });
        // KC user remains disabled + orphaned-but-known. Don't roll back —
        // the admin can still trigger an action manually.
        return reply.status(500).send({
          error: 'InternalServerError',
          code: 'TOKEN_MINT_FAILED',
          message: 'could not mint approval tokens',
        });
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
        logger.error({
          operation: 'aggregator-registration.create',
          status: 'failure',
          step: 'mailer.send',
          error: mailResult.error.message,
          error_code: mailResult.error.code,
        });
      }

      logger.info({
        operation: 'aggregator-registration.create',
        status: 'success',
        aggregator_id: aggregatorId,
        org_slug: orgSlug,
        keycloak_user_id: kcResult.value.id,
      });

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
