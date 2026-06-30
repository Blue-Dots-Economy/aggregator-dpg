/**
 * Admin-review notification for the aggregator registration flow.
 *
 * Belongs to `@aggregator-dpg/api`. Mints the approve/reject JWT pair and
 * sends the reviewer email. Shared by the initial submit, the resubmit
 * (reclaim) path, and the explicit "resend approval link" endpoint so the
 * three surfaces stay byte-for-byte identical.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { mintApprovalToken, formatApprovalTtl } from './approval-token.js';
import { renderAdminReview } from './email-templates/index.js';
import { getMailer } from './mailer/index.js';
import { httpError } from '../errors/http-error.js';

/** Inputs needed to render and deliver the admin-review email. */
export interface AdminReviewNotifyInput {
  aggregatorId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  /**
   * Parent org id (spec §9). When set, it is minted into the approve/reject
   * tokens as the `org` claim so the decision handler can bind the decision to
   * the coordinator's `parent_org_id`.
   */
  org?: string;
  /**
   * Recipient override. When set (the org owner's email for a coordinator under
   * an org), the review email routes here instead of the network-admin list.
   */
  recipientEmail?: string;
}

/**
 * Parse the comma-separated `ADMIN_EMAILS` env value into a clean array.
 * Tolerates wrapping quotes and stray whitespace; falls back to a safe
 * default when unset.
 *
 * @returns The reviewer recipient list (never empty).
 */
export function parseAdminEmails(): string[] {
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

/**
 * Mint a fresh approve/reject token pair for a registration and email the
 * configured reviewers a review link.
 *
 * @param input - Registration id + applicant identity for the email body.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 */
export async function sendAdminReviewEmail(
  input: AdminReviewNotifyInput,
  log: FastifyBaseLogger,
): Promise<void> {
  let approveToken: string;
  let rejectToken: string;
  try {
    const ttlSec = config.APPROVAL_TOKEN_TTL_SECONDS;
    approveToken = (
      await mintApprovalToken({
        aggregatorId: input.aggregatorId,
        intent: 'approve',
        ttlSec,
        ...(input.org ? { org: input.org } : {}),
      })
    ).token;
    rejectToken = (
      await mintApprovalToken({
        aggregatorId: input.aggregatorId,
        intent: 'reject',
        ttlSec,
        ...(input.org ? { org: input.org } : {}),
      })
    ).token;
  } catch (err) {
    throw httpError('TOKEN_MINT_FAILED', { cause: err });
  }

  const decisionBase = `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/read/${input.aggregatorId}`;
  const reviewMail = renderAdminReview({
    registrationId: input.aggregatorId,
    applicantName: input.applicantName,
    applicantEmail: input.applicantEmail,
    applicantPhone: input.applicantPhone,
    association: input.applicantName,
    aggregatorType: 'aggregator',
    approveUrl: `${decisionBase}?token=${encodeURIComponent(approveToken)}&intent=approve`,
    rejectUrl: `${decisionBase}?token=${encodeURIComponent(rejectToken)}&intent=reject`,
    submittedAt: new Date(),
    expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
  });

  const mailResult = await getMailer().send({
    to: input.recipientEmail ? [input.recipientEmail] : parseAdminEmails(),
    subject: reviewMail.subject,
    html: reviewMail.html,
    text: reviewMail.text,
  });
  if (!mailResult.ok) {
    log.warn(
      {
        operation: 'registration-notify.sendAdminReviewEmail',
        status: 'failure',
        sub_operation: 'mailer.send',
        code: mailResult.error.code,
        cause: mailResult.error.message,
      },
      'admin review email delivery failed — registration still recorded',
    );
  }
}
