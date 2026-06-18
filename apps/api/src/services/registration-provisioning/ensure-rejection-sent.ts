/**
 * Idempotent executor: send the rejection email to the applicant.
 *
 * Skips when `provisionState.rejection === 'done'`. Applies a cooldown guard
 * against `rejectionSentAt` to avoid hammering the mailer on rapid retries.
 * Stamps `rejection_sent_at` atomically with the `done` provision mark.
 */

import { logger } from '../../logger.js';
import { renderApplicantRejected } from '../email-templates/index.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { MailerAdapter } from '../mailer/interface.js';
import { handleProvisionFailure } from './provision-failure.js';
import type { EnsureResult } from './index.js';

export interface EnsureRejectionSentDeps {
  store: RegistrationStoreBase;
  mailer: MailerAdapter;
  /** Optional rejection reason surfaced to the applicant. */
  reason?: string;
  /** Dead-letter threshold; read from `config.REGISTRATION_MAX_PROVISION_ATTEMPTS`. */
  maxAttempts: number;
  /** Minimum minutes between sends; read from `config.REGISTRATION_WELCOME_RESEND_COOLDOWN_MINUTES`. */
  cooldownMinutes: number;
}

/**
 * Ensures the rejection email has been sent to the applicant.
 *
 * Skips silently when within the cooldown window (prevents hammering the mailer
 * on rapid reconciler retries). Stamps `rejection_sent_at` and marks
 * `provisionState.rejection = 'done'` atomically in the same store write.
 *
 * @param reg - Registration in `rejected` state.
 * @param deps - Mailer, store, optional reason, and retry config.
 * @returns ok on success or skip; ok: false on send failure.
 */
export async function ensureRejectionSent(
  reg: Registration,
  deps: EnsureRejectionSentDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureRejectionSent';
  const start = Date.now();

  if (reg.provisionState.rejection === 'done') {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'already_done',
    });
    return { ok: true };
  }

  // Cooldown guard: skip if already sent within the configured window.
  if (reg.rejectionSentAt) {
    const cooldownMs = deps.cooldownMinutes * 60 * 1000;
    if (Date.now() - reg.rejectionSentAt.getTime() < cooldownMs) {
      logger.debug({
        operation: op,
        status: 'skipped',
        registration_id: reg.id,
        reason: 'cooldown',
      });
      return { ok: true };
    }
  }

  try {
    const contactName = extractContactName(reg);
    const { subject, html, text } = renderApplicantRejected({
      contactName,
      association: reg.orgName,
      reason: deps.reason,
    });

    const mailResult = await deps.mailer.send({ to: reg.contactEmail, subject, html, text });

    if (!mailResult.ok) {
      return handleProvisionFailure(
        op,
        reg,
        'rejection',
        mailResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }

    // Stamp rejection_sent_at atomically with the done mark.
    await deps.store.markProjection(reg.id, 'rejection', 'done', { rejectionSentAt: new Date() });
    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      latency_ms: Date.now() - start,
    });
    return { ok: true };
  } catch (err: unknown) {
    return handleProvisionFailure(
      op,
      reg,
      'rejection',
      err instanceof Error ? err.message : 'unknown',
      deps.store,
      deps.maxAttempts,
      start,
    );
  }
}

function extractContactName(reg: Registration): string {
  const draft = reg.profileDraft as Record<string, unknown>;
  const name = draft['contact_name'] ?? draft['name'] ?? draft['contactName'];
  return typeof name === 'string' && name.trim() ? name.trim() : reg.orgName;
}
