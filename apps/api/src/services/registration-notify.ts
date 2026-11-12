/**
 * Review-token minting for the emailed approve/reject pages (`@aggregator-dpg/api`).
 *
 * Used by the "resend approval link" endpoints of registrations made before
 * onboarding became invite-only.
 */

import { config } from '../config.js';
import { mintApprovalToken } from './approval-token.js';
import { httpError } from '../errors/http-error.js';

/**
 * Mints the review token for the approve/reject page.
 *
 * The action is chosen on the page; the token's `intent` claim is ignored.
 *
 * @param subjectId - The record id bound as the token subject (aggregator or org id).
 * @param org - Optional parent-org id minted as the `org` claim (coordinator flow).
 * @returns The signed review token.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if the JWT cannot be minted.
 */
export async function mintReviewToken(subjectId: string, org?: string): Promise<string> {
  const ttlSec = config.APPROVAL_TOKEN_TTL_SECONDS;
  const orgClaim = org ? { org } : {};
  try {
    return (
      await mintApprovalToken({ aggregatorId: subjectId, intent: 'approve', ttlSec, ...orgClaim })
    ).token;
  } catch (err) {
    throw httpError('TOKEN_MINT_FAILED', { cause: err });
  }
}
