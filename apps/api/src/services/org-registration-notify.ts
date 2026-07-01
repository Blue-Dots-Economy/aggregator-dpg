/**
 * Org-review notification for the org registration flow.
 *
 * Belongs to `@aggregator-dpg/api`. Mints the org approve/reject JWT pair
 * (sub = org id, no `org` claim — the **network admin** is the approver, not
 * an org owner) and emails the configured network admins a review link.
 * Shared by org submit and the §7 org-refresh path.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { mintApprovalToken, formatApprovalTtl } from './approval-token.js';
import { renderAdminReview } from './email-templates/index.js';
import { getMailer } from './mailer/index.js';
import { parseAdminEmails } from './registration-notify.js';
import { httpError } from '../errors/http-error.js';

/** Inputs needed to render and deliver the org-review email. */
export interface OrgReviewNotifyInput {
  orgId: string;
  displayName: string;
  ownerEmail: string;
  /** Org owner's phone (E.164) — shown in the review email's Phone row. */
  ownerPhone: string;
}

/**
 * Mints org approve/reject tokens and emails the network admins a review link.
 *
 * @param input - Org id + display name + owner email for the email body.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 */
export async function sendOrgReviewEmail(
  input: OrgReviewNotifyInput,
  log: FastifyBaseLogger,
): Promise<void> {
  let approveToken: string;
  let rejectToken: string;
  try {
    const ttlSec = config.APPROVAL_TOKEN_TTL_SECONDS;
    approveToken = (
      await mintApprovalToken({ aggregatorId: input.orgId, intent: 'approve', ttlSec })
    ).token;
    rejectToken = (await mintApprovalToken({ aggregatorId: input.orgId, intent: 'reject', ttlSec }))
      .token;
  } catch (err) {
    throw httpError('TOKEN_MINT_FAILED', { cause: err });
  }

  const base = `${config.PUBLIC_API_URL}/admin/v1/orgs/read/${input.orgId}`;
  const mail = renderAdminReview({
    registrationId: input.orgId,
    applicantName: input.displayName,
    applicantEmail: input.ownerEmail,
    applicantPhone: input.ownerPhone,
    association: input.displayName,
    // The shared template's `aggregatorType` field has no 'org' member; use
    // 'aggregator' (cosmetic — the org-review email's Type row only). Locked
    // vocabulary still governs new user-facing surfaces.
    aggregatorType: 'aggregator',
    approveUrl: `${base}?token=${encodeURIComponent(approveToken)}&intent=approve`,
    rejectUrl: `${base}?token=${encodeURIComponent(rejectToken)}&intent=reject`,
    submittedAt: new Date(),
    expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
  });

  const sent = await getMailer().send({
    to: parseAdminEmails(),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok) {
    log.warn(
      {
        operation: 'org-registration-notify.sendOrgReviewEmail',
        status: 'failure',
        sub_operation: 'mailer.send',
        code: sent.error.code,
        cause: sent.error.message,
      },
      'org review email delivery failed — org still recorded',
    );
  }
}
