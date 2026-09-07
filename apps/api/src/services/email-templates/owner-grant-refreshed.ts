/**
 * Owner grant-refreshed email (#701) — sent when an org owner requests a fresh
 * invite-management link because their previous one expired.
 *
 * Belongs to `@aggregator-dpg/api`. Distinct from `org-owner-approved` on
 * purpose: the owner did NOT just get approved (that may have been 90+ days
 * ago), they asked for a new link — so reusing the approval email would read
 * as a duplicate or a phishing attempt. No sign-in CTA (the owner has no
 * account). Copy lives under `owner_grant_refreshed.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/**
 * Template inputs for the owner grant-refreshed email.
 */
export interface OwnerGrantRefreshedVars {
  /** The organisation the refreshed link manages invites for. */
  orgName: string;
  /** The invite-management page URL carrying the fresh grant token. */
  inviteUrl: string;
}

/**
 * Renders the owner grant-refreshed email.
 *
 * @param v - Organisation name and the fresh invite-management link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOwnerGrantRefreshed(v: OwnerGrantRefreshedVars): RenderedEmail {
  return renderCase('owner_grant_refreshed', {
    orgName: v.orgName,
    inviteUrl: v.inviteUrl,
  });
}
