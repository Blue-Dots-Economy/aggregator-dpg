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
 * Mint the approve + reject token pair for a review link.
 *
 * @param subjectId - The record id bound as the token subject (aggregator or org id).
 * @param org - Optional parent-org id minted as the `org` claim (coordinator flow).
 * @returns The signed approve + reject tokens.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 */
export async function mintApprovalTokenPair(
  subjectId: string,
  org?: string,
): Promise<{ approveToken: string; rejectToken: string }> {
  const ttlSec = config.APPROVAL_TOKEN_TTL_SECONDS;
  const orgClaim = org ? { org } : {};
  try {
    const approveToken = (
      await mintApprovalToken({ aggregatorId: subjectId, intent: 'approve', ttlSec, ...orgClaim })
    ).token;
    const rejectToken = (
      await mintApprovalToken({ aggregatorId: subjectId, intent: 'reject', ttlSec, ...orgClaim })
    ).token;
    return { approveToken, rejectToken };
  } catch (err) {
    throw httpError('TOKEN_MINT_FAILED', { cause: err });
  }
}

/** Shared inputs for rendering + delivering an admin/owner review email. */
export interface ReviewEmailInput {
  /** Record id — token subject, read-URL segment, and email `registrationId`. */
  subjectId: string;
  /** Path segment under `/admin/v1/` for the read URL, e.g. `aggregator-registrations` or `orgs`. */
  readPath: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  /** Resolved recipient list (network admins, or an org owner). */
  recipients: string[];
  /** Optional `org` token claim (coordinator-under-org flow). */
  org?: string;
  /** Structured-log operation label for the delivery-failure warning. */
  logOperation: string;
}

/**
 * Mint the token pair, render the shared admin-review email, and deliver it.
 * The single delivery path behind both the coordinator and org review emails.
 *
 * @param input - Review-email fields + resolved recipients.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 */
export async function sendReviewEmail(
  input: ReviewEmailInput,
  log: FastifyBaseLogger,
): Promise<void> {
  const { approveToken, rejectToken } = await mintApprovalTokenPair(input.subjectId, input.org);
  const base = `${config.PUBLIC_API_URL}/admin/v1/${input.readPath}/read/${input.subjectId}`;
  const reviewMail = renderAdminReview({
    registrationId: input.subjectId,
    applicantName: input.applicantName,
    applicantEmail: input.applicantEmail,
    applicantPhone: input.applicantPhone,
    association: input.applicantName,
    aggregatorType: 'aggregator',
    approveUrl: `${base}?token=${encodeURIComponent(approveToken)}&intent=approve`,
    rejectUrl: `${base}?token=${encodeURIComponent(rejectToken)}&intent=reject`,
    submittedAt: new Date(),
    expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
  });

  const mailResult = await getMailer().send({
    to: input.recipients,
    subject: reviewMail.subject,
    html: reviewMail.html,
    text: reviewMail.text,
  });
  if (!mailResult.ok) {
    log.warn(
      {
        operation: input.logOperation,
        status: 'failure',
        sub_operation: 'mailer.send',
        code: mailResult.error.code,
        cause: mailResult.error.message,
      },
      'review email delivery failed — record still saved',
    );
  }
}

/**
 * Mint a fresh approve/reject token pair for a coordinator registration and
 * email the reviewers (or the org owner, when routed under an org) a review link.
 *
 * @param input - Registration id + applicant identity for the email body.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 */
export async function sendAdminReviewEmail(
  input: AdminReviewNotifyInput,
  log: FastifyBaseLogger,
): Promise<void> {
  await sendReviewEmail(
    {
      subjectId: input.aggregatorId,
      readPath: 'aggregator-registrations',
      applicantName: input.applicantName,
      applicantEmail: input.applicantEmail,
      applicantPhone: input.applicantPhone,
      recipients: input.recipientEmail ? [input.recipientEmail] : parseAdminEmails(),
      ...(input.org ? { org: input.org } : {}),
      logOperation: 'registration-notify.sendAdminReviewEmail',
    },
    log,
  );
}
