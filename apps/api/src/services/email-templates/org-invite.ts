/**
 * Org-invite email: sent to each address an owner invites to register an
 * organisation under theirs, carrying the registration link with the invite token.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under `org_invite.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';
import type { CoordinatorInviteVars } from './coordinator-invite.js';

/** Template inputs for the org-invite email; `orgName` is the inviting org. */
export type OrgInviteVars = CoordinatorInviteVars;

/**
 * Renders the org-invite email.
 *
 * @param v - Inviting org name, inviter contact, invite link, absolute expiry, optional name.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgInvite(v: OrgInviteVars): RenderedEmail {
  return renderCase('org_invite', {
    orgName: v.orgName,
    inviterEmail: v.inviterEmail,
    inviteUrl: v.inviteUrl,
    expiresOn: v.expiresOn,
    recipientName: v.recipientName,
  });
}
