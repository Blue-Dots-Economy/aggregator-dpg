/**
 * Invite-joined emails: sent to the inviting org's owner once an invitee has
 * verified their email and is active.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under `coordinator_joined.*` and `org_joined.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

/** Template inputs for a coordinator who joined. */
export interface CoordinatorJoinedVars {
  /** The coordinator's name. */
  joinerName: string;
  joinerEmail: string;
  /** The org they joined. */
  orgName: string;
  consoleUrl: string;
}

/** Template inputs for an org that joined. */
export interface OrgJoinedVars {
  /** The new org's name. */
  orgName: string;
  ownerEmail: string;
  /** The org it registered under. */
  parentName: string;
  consoleUrl: string;
}

/**
 * Renders the mail telling an owner that an invited coordinator joined.
 *
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderCoordinatorJoined(v: CoordinatorJoinedVars): RenderedEmail {
  return renderCase('coordinator_joined', { ...v });
}

/**
 * Renders the mail telling an owner that an invited org joined.
 *
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgJoined(v: OrgJoinedVars): RenderedEmail {
  return renderCase('org_joined', { ...v });
}
