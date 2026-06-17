/**
 * Idempotent executor: send the welcome email to a newly-approved applicant.
 *
 * Skips when `provisionState.welcome === 'done'`.
 */

import { logger } from '../../logger.js';
import { renderApplicantApproved } from '../email-templates/index.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { MailerAdapter } from '../mailer/interface.js';
import type { EnsureResult } from './index.js';

export interface EnsureWelcomeSentDeps {
  store: RegistrationStoreBase;
  mailer: MailerAdapter;
  /** Portal sign-in URL included in the welcome email. */
  portalUrl: string;
}

/**
 * Ensures the welcome email has been sent to the newly-approved applicant.
 *
 * @param reg - Registration in `approved` or `active` state.
 * @param deps - Mailer + store.
 * @returns ok on success or skip; ok: false on send failure.
 */
export async function ensureWelcomeSent(
  reg: Registration,
  deps: EnsureWelcomeSentDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureWelcomeSent';
  const start = Date.now();

  if (reg.provisionState.welcome === 'done') {
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
    const signInUrl = `${deps.portalUrl}/login`;

    const { subject, html, text } = renderApplicantApproved({
      contactName,
      association: reg.orgName,
      identifier: reg.contactEmail,
      signInUrl,
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
      await deps.store.markProjection(reg.id, 'welcome', 'failed');
      return { ok: false, error: mailResult.error.message };
    }

    await deps.store.markProjection(reg.id, 'welcome', 'done');
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
    await deps.store.markProjection(reg.id, 'welcome', 'failed');
    return { ok: false, error: message };
  }
}

function extractContactName(reg: Registration): string {
  const draft = reg.profileDraft as Record<string, unknown>;
  const name = draft['contact_name'] ?? draft['name'] ?? draft['contactName'];
  return typeof name === 'string' && name.trim() ? name.trim() : reg.orgName;
}
