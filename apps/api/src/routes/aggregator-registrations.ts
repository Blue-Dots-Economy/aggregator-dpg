/**
 * Aggregator registration submit endpoint.
 *
 * Redesigned submit flow (registration FSM):
 *   1. Validate body against `RegistrationPayloadSchema` (Zod) AND
 *      `registration.v1.json` (Ajv). The JSON Schema is the authoritative
 *      contract that drives the UI form; Zod gives type-safe parsing.
 *   2. Normalise `contact.phone` to E.164.
 *   3. Per (email, IP) rate-limit — coarse guard against form abuse.
 *   4. Compute idempotency fingerprint: sha256 of `${email}|${phone}|${orgName}`.
 *      An existing row with the same key → replay the 202, no second effect.
 *   5. ONE atomic write: INSERT into `registrations` (state=submitted). No
 *      external calls happen here; the row is the source of truth.
 *   6. Best-effort: call `ensureVerificationSent` after the commit. A failure
 *      never rolls back the row — the reconciler will retry.
 *   7. Return UNIFORM 202 Accepted for ALL paths (new, replay, duplicate
 *      email/phone) so the endpoint is not an existence oracle.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RegistrationPayloadSchema } from '@aggregator-dpg/shared-primitives/aggregator';
import { config } from '../config.js';
import { getRegistrationValidator } from '../services/registration-validator.js';
import { getRegistrationStore } from '../services/registration-store/index.js';
import { getMailer } from '../services/mailer/index.js';
import { ensureVerificationSent } from '../services/registration-provisioning/index.js';
import { normalisePhone } from '../services/phone.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { consume } from '../services/rate-limiter/index.js';
import { httpError } from '../errors/http-error.js';
import { logger } from '../logger.js';
import { errorResponses } from '../errors/openapi.js';

const SUBMIT_RESPONSE = {
  message: 'Registration received. Check your email to verify your address.',
};

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
      const log = req.log.child({ operation: 'aggregator-registration.submit' });
      const start = Date.now();

      // The BFF attaches a service-account bearer token (client_credentials on
      // `aggregator-bff`). `authenticateAny` only verifies the JWT signature
      // and issuer/exp — it does not require an `aggregator_id` claim.
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
      const email = body.contact.email; // already lowercased by Zod transform

      // Per (email, IP) coarse rate limit. Fails open on Redis blips.
      const ip = (req.ip ?? '0.0.0.0').toString();
      const rate = await consume({
        namespace: 'reg-submit',
        key: `${email}:${ip}`,
        windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
        max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
      });
      if (!rate.allowed) {
        void reply.header('Retry-After', String(rate.retryAfterSeconds));
        log.warn({ status: 'rate_limited', count: rate.count, ip });
        throw httpError('RATE_LIMITED', {
          detail: `Too many registration attempts. Retry in ${rate.retryAfterSeconds}s.`,
        });
      }

      // Deterministic idempotency key — same applicant resubmitting the form
      // lands on the same row without needing a client-supplied key.
      const idempotencyKey = computeFingerprint(email, phoneE164, body.name.trim());
      const store = getRegistrationStore();

      // Check for an existing row first (idempotency replay).
      const existing = await store.findByIdempotencyKey(idempotencyKey);
      if (!existing.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(existing.error.message),
          fields: { sub_operation: 'store.findByIdempotencyKey' },
        });
      }
      if (existing.value !== null) {
        log.info({
          status: 'idempotency_replay',
          registration_id: existing.value.id,
          latency_ms: Date.now() - start,
        });
        return reply.status(202).send(SUBMIT_RESPONSE);
      }

      const serverConsent = stampConsent(body.consent);
      const createResult = await store.create({
        idempotencyKey,
        contactEmail: email,
        contactPhone: phoneE164,
        orgName: body.name.trim(),
        orgType: body.type,
        orgUrl: body.url ?? null,
        orgLocations: body.locations ?? [],
        profileDraft: {},
        consent: serverConsent,
      });

      if (!createResult.ok) {
        const errCode = createResult.error.code;

        // DUPLICATE_IDEMPOTENCY_KEY → concurrent insert won; treat as replay.
        if (errCode === 'DUPLICATE_IDEMPOTENCY_KEY') {
          log.info({
            status: 'concurrent_idempotency_replay',
            latency_ms: Date.now() - start,
          });
          return reply.status(202).send(SUBMIT_RESPONSE);
        }

        // DUPLICATE_EMAIL / DUPLICATE_PHONE → uniform 202 (no existence oracle).
        // The applicant will not receive a verification email for a different
        // registration, but we must not reveal whether their contact was found.
        if (errCode === 'DUPLICATE_EMAIL' || errCode === 'DUPLICATE_PHONE') {
          log.info({
            status: 'duplicate_contact_silent',
            duplicate_field: errCode === 'DUPLICATE_EMAIL' ? 'email' : 'phone',
            latency_ms: Date.now() - start,
          });
          return reply.status(202).send(SUBMIT_RESPONSE);
        }

        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(createResult.error.message),
          fields: { sub_operation: 'store.create' },
        });
      }

      const reg = createResult.value;

      // Best-effort: send the verification email. A failure here does NOT roll
      // back the row — the reconciler will retry on the next tick.
      try {
        await ensureVerificationSent(reg, {
          store,
          mailer: getMailer(),
          portalUrl: config.PUBLIC_PORTAL_URL,
          cooldownMinutes: config.REGISTRATION_RESEND_COOLDOWN_MINUTES,
          ttlMinutes: config.REGISTRATION_VERIFICATION_TTL_MINUTES,
        });
      } catch (err) {
        logger.warn({
          operation: 'aggregator-registration.submit',
          status: 'verification_send_failed',
          registration_id: reg.id,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }

      log.info({
        status: 'success',
        registration_id: reg.id,
        latency_ms: Date.now() - start,
      });

      return reply.status(202).send(SUBMIT_RESPONSE);
    },
  );
}

/**
 * Maximum consent validity window. Hard ceiling so a buggy or hostile
 * client cannot persist a consent record that is effectively permanent.
 */
const MAX_CONSENT_VALIDITY_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/**
 * Server-stamps `given_at` to the current instant and clamps `valid_till` to
 * at most five years after that instant.
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

/**
 * Computes a deterministic idempotency fingerprint for a registration.
 *
 * @param email - Normalised (lowercased) contact email.
 * @param phone - E.164 contact phone.
 * @param orgName - Trimmed organisation name.
 * @returns Hex SHA-256 digest prefixed with `reg:`.
 */
function computeFingerprint(email: string, phone: string, orgName: string): string {
  return 'reg:' + createHash('sha256').update(`${email}|${phone}|${orgName}`).digest('hex');
}
