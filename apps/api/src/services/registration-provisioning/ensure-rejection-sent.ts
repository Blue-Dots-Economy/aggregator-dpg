/**
 * Idempotent executor: send the rejection email to the applicant.
 *
 * Skips when `provisionState.rejection === 'done'`.
 */

import { logger } from '../../logger.js';
import { renderApplicantRejected } from '../email-templates/index.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { MailerAdapter } from '../mailer/interface.js';
import type { EnsureResult } from './index.js';

export interface EnsureRejectionSentDeps {
  store: RegistrationStoreBase;
  mailer: MailerAdapter;
  /** Optional rejection reason surfaced to the applicant. */
  reason?: string;
}

/**
 * Ensures the rejection email has been sent to the applicant.
 *
 * @param reg - Registration in `rejected` state.
 * @param deps - Mailer + store + optional reason.
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

  try {
    const contactName = extractContactName(reg);
    const { subject, html, text } = renderApplicantRejected({
      contactName,
      association: reg.orgName,
      reason: deps.reason,
    });

    const mailResult = await deps.mailer.send({ to: reg.contactEmail, subject, html, text });

    if (!mailResult.ok) {
      logger.error({
        operation: op,
        status: 'failure',
        registration_id: reg.id,
        error: mailResult.error.message,
        error_type: mailResult.error.code,
        latency_ms: Date.now() - start,
      });
      await deps.store.markProjection(reg.id, 'rejection', 'failed');
      return { ok: false, error: mailResult.error.message };
    }

    await deps.store.markProjection(reg.id, 'rejection', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      latency_ms: Date.now() - start,
    });
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown';
    logger.error({
      operation: op,
      status: 'failure',
      registration_id: reg.id,
      error: message,
      latency_ms: Date.now() - start,
    });
    await deps.store.markProjection(reg.id, 'rejection', 'failed');
    return { ok: false, error: message };
  }
}

function extractContactName(reg: Registration): string {
  const draft = reg.profileDraft as Record<string, unknown>;
  const name = draft['contact_name'] ?? draft['name'] ?? draft['contactName'];
  return typeof name === 'string' && name.trim() ? name.trim() : reg.orgName;
}
