/**
 * Org-owner approved email (#699) — tells the org owner their organisation is
 * live. No sign-in CTA: the owner's Keycloak user stays disabled by design
 * (org-owner console login is deferred), so the invite link is their only
 * action.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under `org_owner_approved.*`.
 * The tail is two sets of layout blocks gated on whether the grant link
 * exists — with it, a lead plus button plus standing note; without it, a
 * heads-up that the link follows.
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
  /**
   * Coordinator-invite grant link, when it exists (#701). Omit until the
   * invite subsystem ships — the approval notification has standalone value.
   */
  inviteUrl?: string;
}

/**
 * Renders the org-owner approved email.
 *
 * @param v - Organisation name, owner email, and the optional invite link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgOwnerApproved(v: OrgOwnerApprovedVars): RenderedEmail {
  return renderCase('org_owner_approved', {
    orgName: v.orgName,
    ownerEmail: v.ownerEmail,
    inviteUrl: v.inviteUrl,
  });
}
