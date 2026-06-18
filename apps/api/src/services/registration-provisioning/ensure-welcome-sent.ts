/**
 * Idempotent executor: send the welcome email to a newly-approved applicant.
 *
 * Skips when `provisionState.welcome === 'done'`. Applies a cooldown guard
 * against `welcomeSentAt` to avoid hammering the mailer on rapid retries.
 * Stamps `welcome_sent_at` atomically with the `done` provision mark.
 */

import { logger } from '../../logger.js';
import { renderApplicantApproved } from '../email-templates/index.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { MailerAdapter } from '../mailer/interface.js';
import { handleProvisionFailure } from './provision-failure.js';
import type { EnsureResult } from './index.js';

export interface EnsureWelcomeSentDeps {
  store: RegistrationStoreBase;
  mailer: MailerAdapter;
  /** Portal sign-in URL included in the welcome email. */
  portalUrl: string;
  /** Dead-letter threshold; read from `config.REGISTRATION_MAX_PROVISION_ATTEMPTS`. */
  maxAttempts: number;
  /** Minimum minutes between sends; read from `config.REGISTRATION_WELCOME_RESEND_COOLDOWN_MINUTES`. */
  cooldownMinutes: number;
}

/**
 * Ensures the welcome email has been sent to the newly-approved applicant.
 *
 * Skips silently when within the cooldown window (prevents hammering the mailer
 * on rapid reconciler retries). Stamps `welcome_sent_at` and marks
 * `provisionState.welcome = 'done'` atomically in the same store write.
 *
 * @param reg - Registration in `approved` or `active` state.
 * @param deps - Mailer, store, portal URL, and retry config.
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

  // Cooldown guard: skip if already sent within the configured window.
  if (reg.welcomeSentAt) {
    const cooldownMs = deps.cooldownMinutes * 60 * 1000;
    if (Date.now() - reg.welcomeSentAt.getTime() < cooldownMs) {
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
    const signInUrl = `${deps.portalUrl}/login`;

    const { subject, html, text } = renderApplicantApproved({
      contactName,
      association: reg.orgName,
      identifier: reg.contactEmail,
      signInUrl,
    });

    const mailResult = await deps.mailer.send({ to: reg.contactEmail, subject, html, text });

    if (!mailResult.ok) {
      return handleProvisionFailure(
        op,
        reg,
        'welcome',
        mailResult.error.message,
        deps.store,
        deps.maxAttempts,
        start,
      );
    }

    // Stamp welcome_sent_at atomically with the done mark to avoid the crash
    // window between a successful send and a separate markProjection call.
    await deps.store.markProjection(reg.id, 'welcome', 'done', { welcomeSentAt: new Date() });
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
      'welcome',
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
