/**
 * Idempotent executor: notify admins with approve/reject deep-links.
 *
 * Mints a signed approve token and a signed reject token, then emails the
 * `ADMIN_EMAILS` list. Skips when `provisionState.admin_notify === 'done'`
 * or when the cooldown has not elapsed.
 */

import { logger } from '../../logger.js';
import { mintRegistrationApprovalToken } from '../approval-token.js';
import { renderAdminReview } from '../email-templates/index.js';
import type { RegistrationStoreBase, Registration } from '../registration-store/interface.js';
import type { MailerAdapter } from '../mailer/interface.js';
import type { EnsureResult } from './index.js';

export interface EnsureAdminNotifiedDeps {
  store: RegistrationStoreBase;
  mailer: MailerAdapter;
  /** Public API base URL (including any reverse-proxy prefix, e.g. `https://host/backend`). Links go to `${apiUrl}/admin/v1/aggregator-registrations/read/:id?intent=approve|reject`. */
  apiUrl: string;
  /** Comma-separated or array of admin email addresses. */
  adminEmails: string[];
  /** Minimum minutes between notification resends. */
  cooldownMinutes: number;
  /** Token TTL in seconds (defaults to 7 days). */
  tokenTtlSec?: number;
}

const DEFAULT_TOKEN_TTL_SEC = 7 * 24 * 3600; // 7 days

/**
 * Ensures the admin notification has been sent for a `verified` registration.
 *
 * The email carries signed approve + reject URLs. Idempotent: a second call
 * while `provisionState.admin_notify === 'done'` is a no-op.
 *
 * @param reg - The registration row in `verified` state.
 * @param deps - External dependencies: store, mailer, config.
 * @returns ok on success or skip; ok: false when the send fails.
 */
export async function ensureAdminNotified(
  reg: Registration,
  deps: EnsureAdminNotifiedDeps,
): Promise<EnsureResult> {
  const op = 'provisioning.ensureAdminNotified';
  const start = Date.now();

  if (reg.provisionState.admin_notify === 'done') {
    logger.debug({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'already_done',
    });
    return { ok: true };
  }

  if (deps.adminEmails.length === 0) {
    logger.warn({
      operation: op,
      status: 'skipped',
      registration_id: reg.id,
      reason: 'no_admin_emails',
    });
    return { ok: true };
  }

  if (reg.adminNotifiedAt) {
    const elapsed = (Date.now() - reg.adminNotifiedAt.getTime()) / 60_000;
    if (elapsed < deps.cooldownMinutes) {
      logger.debug({
        operation: op,
        status: 'skipped',
        registration_id: reg.id,
        reason: 'cooldown',
        elapsed_min: Math.floor(elapsed),
      });
      return { ok: true };
    }
  }

  try {
    const ttlSec = deps.tokenTtlSec ?? DEFAULT_TOKEN_TTL_SEC;

    const [approveResult, rejectResult] = await Promise.all([
      mintRegistrationApprovalToken({ registrationId: reg.id, intent: 'approve', ttlSec }),
      mintRegistrationApprovalToken({ registrationId: reg.id, intent: 'reject', ttlSec }),
    ]);

    const approveUrl = `${deps.apiUrl}/admin/v1/aggregator-registrations/read/${encodeURIComponent(reg.id)}?intent=approve&token=${encodeURIComponent(approveResult.token)}`;
    const rejectUrl = `${deps.apiUrl}/admin/v1/aggregator-registrations/read/${encodeURIComponent(reg.id)}?intent=reject&token=${encodeURIComponent(rejectResult.token)}`;

    const { subject, html, text } = renderAdminReview({
      registrationId: reg.id,
      applicantName: extractContactName(reg),
      applicantEmail: reg.contactEmail,
      applicantPhone: reg.contactPhone,
      association: reg.orgName,
      aggregatorType: reg.orgType as 'seeker' | 'provider' | 'aggregator' | 'both',
      approveUrl,
      rejectUrl,
      submittedAt: reg.createdAt,
    });

    const mailResult = await deps.mailer.send({
      to: deps.adminEmails,
      subject,
      html,
      text,
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
      await deps.store.markProjection(reg.id, 'admin_notify', 'failed');
      return { ok: false, error: mailResult.error.message };
    }

    await deps.store.markProjection(reg.id, 'admin_notify', 'done');
    logger.info({
      operation: op,
      status: 'success',
      registration_id: reg.id,
      admin_count: deps.adminEmails.length,
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
    await deps.store.markProjection(reg.id, 'admin_notify', 'failed');
    return { ok: false, error: message };
  }
}

function extractContactName(reg: Registration): string {
  const draft = reg.profileDraft as Record<string, unknown>;
  const name = draft['contact_name'] ?? draft['name'] ?? draft['contactName'];
  return typeof name === 'string' && name.trim() ? name.trim() : reg.orgName;
}
