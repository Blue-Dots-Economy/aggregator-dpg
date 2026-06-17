/**
 * Aggregator registration email-verification endpoint.
 *
 * Called when the applicant clicks the link in their verification email.
 * Validates the signed verification token, performs a compare-and-set
 * transition `submitted → verified`, and then kicks off best-effort admin
 * notification.
 *
 * Idempotent: if the registration is already in `verified` (or any
 * post-verified) state, the endpoint returns 200 without re-sending the
 * admin notification.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyVerificationToken } from '../services/approval-token.js';
import { getRegistrationStore } from '../services/registration-store/index.js';
import { getMailer } from '../services/mailer/index.js';
import { ensureAdminNotified } from '../services/registration-provisioning/index.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { logger } from '../logger.js';

export async function registerAggregatorRegistrationVerifyRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    '/v1/aggregator-registrations/:id/verify',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { token?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const log = req.log.child({ operation: 'aggregator-registration.verify' });
      const start = Date.now();
      const registrationId = req.params.id;
      const token =
        req.query.token ?? ((req.body as Record<string, unknown>)?.token as string | undefined);

      if (!token) {
        throw httpError('VERIFICATION_TOKEN_INVALID', {
          detail: 'Verification token is missing.',
        });
      }

      const verified = await verifyVerificationToken(token);
      if (!verified.ok) {
        if (verified.error.code === 'EXPIRED') {
          throw httpError('VERIFICATION_TOKEN_EXPIRED');
        }
        throw httpError('VERIFICATION_TOKEN_INVALID', {
          detail: verified.error.message,
        });
      }

      if (verified.registrationId !== registrationId) {
        throw httpError('VERIFICATION_TOKEN_INVALID', {
          detail: 'Token does not match the requested registration.',
        });
      }

      const store = getRegistrationStore();
      const loadResult = await store.findById(registrationId);
      if (!loadResult.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(loadResult.error.message),
          fields: { sub_operation: 'store.findById' },
        });
      }
      if (!loadResult.value) {
        throw httpError('NOT_FOUND', { detail: 'Registration not found.' });
      }

      const reg = loadResult.value;

      // Idempotent: if already verified (or further along), nothing to do.
      if (reg.state !== 'submitted') {
        log.info({
          status: 'already_verified',
          registration_state: reg.state,
          registration_id: registrationId,
          latency_ms: Date.now() - start,
        });
        return reply.status(200).send({ verified: true });
      }

      // Compare-and-set submitted → verified.
      const transResult = await store.transition(
        registrationId,
        'submitted',
        'verified',
        { verifiedAt: new Date() },
        reg.version,
        { actor: 'applicant', reason: 'email_verification' },
      );

      if (!transResult.ok) {
        if (transResult.error.code === 'STALE_TRANSITION') {
          // Concurrent verify won; treat as success.
          log.info({
            status: 'concurrent_verify_ok',
            registration_id: registrationId,
            latency_ms: Date.now() - start,
          });
          return reply.status(200).send({ verified: true });
        }
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(transResult.error.message),
          fields: { sub_operation: 'store.transition' },
        });
      }

      const verifiedReg = transResult.value;

      // Best-effort: notify admins. A failure here does not surface as an
      // error — the reconciler will retry on the next tick.
      // Admin emails are parsed at request time (not module load) so that
      // env changes in tests take effect.
      const recipients = parseAdminEmails();
      try {
        await ensureAdminNotified(verifiedReg, {
          store,
          mailer: getMailer(),
          apiUrl: config.PUBLIC_API_URL,
          adminEmails: recipients,
          cooldownMinutes: config.REGISTRATION_RESEND_COOLDOWN_MINUTES,
          tokenTtlSec: 7 * 24 * 3600,
        });
      } catch (err) {
        logger.warn({
          operation: 'aggregator-registration.verify',
          status: 'admin_notify_failed',
          registration_id: registrationId,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }

      log.info({
        status: 'success',
        registration_id: registrationId,
        latency_ms: Date.now() - start,
      });

      return reply.status(200).send({ verified: true });
    },
  );
}

/**
 * Parses `ADMIN_EMAILS` at call time so tests that set the env var in
 * `beforeEach` see the updated value rather than the module-load snapshot.
 */
function parseAdminEmails(): string[] {
  let raw = (process.env.ADMIN_EMAILS ?? '').trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  const list = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ['admin@bluedots.local'];
}
