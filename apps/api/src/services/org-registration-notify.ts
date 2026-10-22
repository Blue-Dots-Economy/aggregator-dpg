/**
 * Org-review notification for the org registration flow.
 *
 * Belongs to `@aggregator-dpg/api`. Uses the shared `sendReviewEmail`. For
 * orgs, the URL segment is `orgs`, the recipient is always the network admin,
 * and the token has no `org` claim. Used by org submit and org refresh.
 */

import type { FastifyBaseLogger } from 'fastify';
import { parseAdminEmails, sendReviewEmail } from './registration-notify.js';

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
 * @param input - Org id + display name + owner email/phone for the email body.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 */
export async function sendOrgReviewEmail(
  input: OrgReviewNotifyInput,
  log: FastifyBaseLogger,
): Promise<void> {
  await sendReviewEmail(
    {
      subjectId: input.orgId,
      readPath: 'orgs',
      applicantName: input.displayName,
      applicantEmail: input.ownerEmail,
      applicantPhone: input.ownerPhone,
      recipients: parseAdminEmails(),
      entityLabel: 'organisation',
      logOperation: 'org-registration-notify.sendOrgReviewEmail',
    },
    log,
  );
}
