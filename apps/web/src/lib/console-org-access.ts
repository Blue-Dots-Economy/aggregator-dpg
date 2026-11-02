/**
 * What the caller may see and do on an organisation's console page, worked
 * out from the signed-in actor and the organisation (`apps/web`, console).
 */

import type { MeResponse, OrgReadResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { can } from './capabilities';

/** What the caller may see and do on an organisation's page. */
export interface OrgPageAccess {
  /** The caller owns the org, or is the network admin; else it is only viewed from above. */
  own: boolean;
  /** The details form is editable: an owned aggregator org other than Default. */
  editable: boolean;
  /** The network admin: rename, "known as" values and the hierarchy limits. */
  canRename: boolean;
  /** The network admin may assign roles to the owner of this aggregator org. */
  canAssignOwner: boolean;
  /** The network admin may re-grant the owner's sign-in access of this active org. */
  canRepair: boolean;
  /** The org may move, once the hierarchy is known: pending or active, and editable. */
  movable: boolean;
  /** A pending org the caller may approve or reject here. */
  canDecide: boolean;
  /** The organisations below are listed: aggregator orgs other than Default. */
  listsChildren: boolean;
}

/**
 * Works out the caller's access to an organisation's page.
 *
 * @param me - The signed-in actor.
 * @param org - The organisation shown.
 * @returns The access flags the page renders from.
 */
export function orgPageAccess(me: MeResponse, org: OrgReadResponse['org']): OrgPageAccess {
  const isAdmin = me.is_network_admin && can(me.capabilities, 'network.administer');
  const isAggregator = org.org_type === 'aggregator';
  const listsChildren = isAggregator && !org.is_default;
  // An owner also views, read-only, the orgs below its own.
  const own = me.is_network_admin || me.orgs.some((o) => o.id === org.id);
  const editable = listsChildren && own;
  return {
    own,
    editable,
    canRename: isAdmin,
    canAssignOwner: isAdmin && isAggregator,
    canRepair: me.is_network_admin && editable && org.status === 'active',
    // The Default org and the root never move; only pending and active orgs can.
    movable: editable && (org.status === 'pending' || org.status === 'active'),
    // A pending org can be decided here as well as in the review list.
    canDecide: isAggregator && org.status === 'pending' && can(me.capabilities, 'orgs.onboard'),
    listsChildren,
  };
}
