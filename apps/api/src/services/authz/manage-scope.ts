/**
 * Which organisations' coordinators an admin may manage (`@aggregator-dpg/api`,
 * RBAC, #873).
 *
 * Reach (`scope.ts`) follows ownership: the network admin reaches every
 * organisation. Managing coordinators (list, read, decide, edit, invite) also
 * needs `org.manage` in the coordinator's organisation, which an
 * organisation's owner holds through Org Admin. The network admin holds it
 * everywhere only when a role in the root grants it; otherwise only in the
 * organisations it owns (such as the Default org).
 *
 * Viewing coordinators (list, read) is wider: `network.administer` in the
 * root lets the network admin see every organisation's coordinators,
 * read-only.
 */

import type { FastifyRequest } from 'fastify';
import type { Capability } from '@aggregator-dpg/rbac';
import type { Actor } from '../auth/actor/index.js';
import { permissionsByOrg } from './guard.js';
import { getRbacRuntime } from './runtime.js';
import { reachableOrgIds } from './scope.js';

/** Why the scope is asked for: changing coordinators, or only reading them. */
export type ScopePurpose = 'manage' | 'view';

/** Root-held permissions that open every organisation, per purpose. */
const ROOT_WIDE: Record<ScopePurpose, readonly Capability[]> = {
  manage: ['org.manage'],
  view: ['org.manage', 'network.administer'],
};

/**
 * The organisations whose coordinators the actor may manage, or view.
 *
 * Narrows reach only in `enforce` mode; in `log` mode a narrower answer is
 * logged and reach is returned, and with access control off reach is
 * returned unchanged.
 *
 * @param req - The request (for its logger).
 * @param actor - The resolved actor.
 * @param rootId - The root organisation's id, when known.
 * @param purpose - `manage` (default) or `view` (read-only).
 * @returns The organisation ids, or null for every organisation.
 */
export async function manageableOrgIds(
  req: FastifyRequest,
  actor: Actor,
  rootId: string | null,
  purpose: ScopePurpose = 'manage',
): Promise<string[] | null> {
  const reach = reachableOrgIds(actor);
  const rt = getRbacRuntime();
  if (!rt) return reach;
  const perms = await permissionsByOrg(req, actor, rootId);
  if (!perms) return reach;
  const manages = (orgId: string) => (perms[orgId] ?? []).includes('org.manage');
  const rootPerms = rootId ? (perms[rootId] ?? []) : [];
  if (ROOT_WIDE[purpose].some((c) => rootPerms.includes(c))) return reach;
  const owned = actor.orgs
    .filter((o) => o.orgType === 'aggregator' && manages(o.id))
    .map((o) => o.id);
  const narrowed = reach === null ? owned : reach.filter((id) => owned.includes(id));
  if (reach !== null && narrowed.length === reach.length) return reach;
  if (rt.mode === 'enforce') return narrowed;
  req.log.warn({
    operation: 'rbac.manage_scope',
    purpose,
    status: 'skipped',
    user_id: actor.userId,
    mode: rt.mode,
    reasons: ['org_manage_not_held'],
    org_count: narrowed.length,
  });
  return reach;
}

/**
 * Whether an organisation is in a manage scope.
 *
 * @param ids - From {@link manageableOrgIds}; null means every organisation.
 * @param orgId - The organisation, or null for none.
 * @returns True when the organisation may be managed.
 */
export function inManageScope(ids: string[] | null, orgId: string | null): boolean {
  if (!orgId) return false;
  return ids === null || ids.includes(orgId);
}
