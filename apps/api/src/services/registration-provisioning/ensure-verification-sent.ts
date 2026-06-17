/**
 * Idempotent executor: send the applicant verification email.
 *
 * Sends a signed verification link to the applicant's stored email address.
 * Skips when `provisionState.verification === 'done'` or when the cooldown
 * period since the last send has not elapsed. On completion, marks
 * `provision_state.verification = 'done'`.
 */

import { logger } from '../../logger.js';
import { mintVerificationToken } from '../approval-token.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { MailerAdapter } from '../mailer/interface.js';
import type { EnsureResult } from './index.js';

export interface EnsureVerificationSentDeps {
  store: RegistrationStoreBase;
  mailer: MailerAdapter;
  /** Public portal base URL — the verify page lives at `${portalUrl}/register/verify`. */
  portalUrl: string;
  /** Minimum minutes between resend attempts. */
  cooldownMinutes: number;
  /** Verification link TTL in minutes. */
  ttlMinutes: number;
}

/**
 * Ensures the verification email has been sent to the applicant.
 *
 * Idempotent: calling this twice for the same registration in `submitted`
 * state sends at most one email (the second call is a no-op if the first
 * succeeded, or a resend if the cooldown elapsed after a failure).
 *
 * @param reg - The registration row to act on.
 * @param deps - External dependencies: store, mailer, config.
 * @returns ok on success or skip; ok: false when the send fails.
 */
export async function ensureVerificationSent(
  reg: Registration,
  deps: EnsureVerificationSentDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureVerificationSent';
  const start = Date.now();

  if (reg.provisionState.verification === 'done') {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'already_done',
    });
    return { ok: true };
  }

  if (reg.verificationSentAt) {
    const elapsed = (Date.now() - reg.verificationSentAt.getTime()) / 60_000;
    if (elapsed < deps.cooldownMinutes) {
      logger.debug({
        operation: op,
        status: 'skipped',
        registration_id: reg.id,
        reason: 'cooldown',
        elapsed_min: Math.floor(elapsed),
        cooldown_min: deps.cooldownMinutes,
      });
      return { ok: true };
    }
  }

  try {
    const { token } = await mintVerificationToken({
      registrationId: reg.id,
      ttlSec: deps.ttlMinutes * 60,
    });

    const verifyUrl = `${deps.portalUrl}/register/verify?id=${encodeURIComponent(reg.id)}&token=${encodeURIComponent(token)}`;

    const mailResult = await deps.mailer.send({
      to: reg.contactEmail,
      subject: 'Verify your email — Blue Dots aggregator registration',
      html: buildVerificationHtml(verifyUrl, deps.ttlMinutes),
      text: buildVerificationText(verifyUrl, deps.ttlMinutes),
    });

    if (!mailResult.ok) {
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: reg.id,
        error: mailResult.error.message,
        error_type: mailResult.error.code,
        latency_ms: Date.now() - start,
      });
      await deps.store.markProjection(reg.id, 'verification', 'failed');
      return { ok: false, error: mailResult.error.message };
    }

    await deps.store.markProjection(reg.id, 'verification', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      latency_ms: Date.now() - start,
    });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error';
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: reg.id,
      error: message,
      latency_ms: Date.now() - start,
    });
    await deps.store.markProjection(reg.id, 'verification', 'failed');
    return { ok: false, error: message };
  }
}

function buildVerificationHtml(url: string, ttlMinutes: number): string {
  return `<p>Please verify your email address to continue your Blue Dots aggregator registration.</p>
<p><a href="${url}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Verify email address</a></p>
<p style="color:#6b7280;font-size:13px;">This link expires in ${ttlMinutes} minutes. If you did not register, ignore this email.</p>`;
}

function buildVerificationText(url: string, ttlMinutes: number): string {
  return `Please verify your email address to continue your Blue Dots aggregator registration.

Verify: ${url}

This link expires in ${ttlMinutes} minutes. If you did not register, ignore this email.`;
}
