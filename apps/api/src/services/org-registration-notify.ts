/**
 * Org-review notification for the org registration flow.
 *
 * Belongs to `@aggregator-dpg/api`. Uses the shared `sendReviewEmail`. For
 * orgs, the URL segment is `orgs` and the token has no `org` claim. The review
 * goes to the owner of the parent organisation, which decides it; a top-level
 * organisation (under the network) goes to the network admins. Used by org
 * submit and org refresh.
 */

import type { FastifyBaseLogger } from 'fastify';
import { httpError } from '../errors/http-error.js';
import { getOrganisationStore } from './organisation-store/index.js';
import { parseAdminEmails, sendReviewEmail } from './registration-notify.js';

/** Inputs needed to render and deliver the org-review email. */
export interface OrgReviewNotifyInput {
  orgId: string;
  displayName: string;
  ownerEmail: string;
  /** Org owner's phone (E.164) — shown in the review email's Phone row. */
  ownerPhone: string;
  /** Parent organisation's id; `null` or the root for a top-level organisation. */
  parentId: string | null;
  /** Parent organisation's name; omitted when unknown. */
  parentName?: string | null;
}

/**
 * Who reviews a new organisation: the parent organisation's owner, or the
 * network admins when the parent is the network.
 *
 * @param parentId - The parent organisation's id, or `null`.
 * @returns The recipient emails.
 * @throws {HttpError} `DB_UNAVAILABLE` when the parent cannot be read.
 */
export async function orgReviewRecipients(parentId: string | null): Promise<string[]> {
  if (parentId === null) return parseAdminEmails();
  const parent = await getOrganisationStore().findById(parentId);
  if (!parent.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(parent.error.message),
      fields: { sub_operation: 'orgStore.findById.parent' },
    });
  }
  // findById returns aggregator orgs only, so the root (or a missing parent) falls back.
  return parent.value ? [parent.value.ownerEmail] : parseAdminEmails();
}

/**
 * Mints org approve/reject tokens and emails the reviewer a review link.
 *
 * @param input - Org id + display name + owner email/phone + parent for the email.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 * @throws {HttpError} `DB_UNAVAILABLE` when the parent cannot be read.
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
      recipients: await orgReviewRecipients(input.parentId),
      entityLabel: 'organisation',
      ...(input.parentName ? { parentName: input.parentName } : {}),
      logOperation: 'org-registration-notify.sendOrgReviewEmail',
    },
    log,
  );
}
