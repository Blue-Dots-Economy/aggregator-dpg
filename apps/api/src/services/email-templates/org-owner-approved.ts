/**
 * Org-owner approved email (#699) — tells the org owner their organisation is
 * live and, since Phase 5, how to sign in to manage it: approval enables the
 * owner's Keycloak user and grants `org_owner`, so the CTA is the portal
 * sign-in link (no 90-day invite grant is minted any more).
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under `org_owner_approved.*`.
 * The tail is two sets of layout blocks gated on whether the link is given —
 * with it, a lead plus button plus standing note; without it, a heads-up that
 * a link follows. The token keeps its historical name `inviteUrl` so operator
 * copy overrides stay valid.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/**
 * Template inputs for the org-owner approved email.
 */
export interface OrgOwnerApprovedVars {
  /** The organisation's display name, as registered. */
  orgName: string;
  /** The owner email the organisation was registered with. */
  ownerEmail: string;
  /** The portal sign-in link (historical token name; see the module doc). */
  inviteUrl?: string;
}

/**
 * Renders the org-owner approved email.
 *
 * @param v - Organisation name, owner email, and the optional sign-in link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgOwnerApproved(v: OrgOwnerApprovedVars): RenderedEmail {
  return renderCase('org_owner_approved', {
    orgName: v.orgName,
    ownerEmail: v.ownerEmail,
    inviteUrl: v.inviteUrl,
  });
}
