/**
 * Store-backed actor resolver (`@aggregator-dpg/api`, user & org Phase 5).
 *
 * Composes the coordinator store, the org store and the identity store, so it
 * runs unchanged against Postgres in production and the in-memory stores in
 * tests.
 */

import { getAggregatorStore, type Aggregator } from '../../aggregator-store/index.js';
import { getAggregatorOrgStore, type AggregatorOrg } from '../../aggregator-org-store/index.js';
import { getIdentityStore } from '../../identity-store/index.js';
import { getGrantStore } from '../../grant-store/index.js';
import { IDP_PROVIDER } from '../../idp-admin/provider.js';
import {
  ActorResolverBase,
  type Actor,
  type ActorOrg,
  type ActorResult,
  type ResolveActorInput,
} from './interface.js';

const unavailable = (message: string): ActorResult => ({
  ok: false,
  error: { code: 'UNAVAILABLE', message },
});

/** The coordinator actor of a stored coordinator row. */
function coordinatorActor(row: Aggregator): Actor {
  const orgs: ActorOrg[] = row.parentOrgId
    ? [
        {
          id: row.parentOrgId,
          orgType: 'aggregator',
          relation: 'member',
          isDefault: row.isDefaultOrg,
        },
      ]
    : [];
  return { userId: row.id, userType: 'coordinator', active: row.status === 'active', orgs };
}

/** An owned aggregator org as an actor org. */
function ownedOrg(org: AggregatorOrg): ActorOrg {
  return {
    id: org.id,
    orgType: 'aggregator',
    relation: 'owner',
    isDefault: org.isDefault,
    permissionSet: org.permissionSet,
  };
}

/**
 * Adds the user's live grants (RBAC R3) to a resolved actor.
 *
 * @returns The actor with `grants`, or `UNAVAILABLE` when the store failed.
 */
async function withGrants(actor: Actor): Promise<ActorResult> {
  const live = await getGrantStore().listLive(actor.userId, new Date());
  if (!live.ok) return unavailable(live.error.message);
  return {
    ok: true,
    value: {
      ...actor,
      grants: live.value.map((g) => ({
        capability: g.capability,
        expiresAt: g.expiresAt.getTime(),
      })),
    },
  };
}

/** Resolves actors from the application's stores. */
export class StoreActorResolver extends ActorResolverBase {
  async resolve(input: ResolveActorInput): Promise<ActorResult> {
    if (input.aggregatorId) return this.claimedCoordinator(input.aggregatorId, input.subject);

    const linked = await getIdentityStore().userOf(IDP_PROVIDER, input.subject);
    if (!linked.ok) return unavailable(linked.error.message);
    if (!linked.value) return { ok: true, value: null };
    const userId = linked.value;

    // A recorded coordinator login without the claim (a realm missing the
    // mapper): still a coordinator, never an admin.
    const asCoordinator = await getAggregatorStore().findById(userId);
    if (!asCoordinator.ok) return unavailable(asCoordinator.error.message);
    if (asCoordinator.value) return this.coordinator(userId);

    const orgStore = getAggregatorOrgStore();
    const [owned, root] = await Promise.all([orgStore.listOwnedBy(userId), orgStore.findRoot()]);
    if (!owned.ok) return unavailable(owned.error.message);
    if (!root.ok) return unavailable(root.error.message);

    const orgs: ActorOrg[] = [];
    if (root.value && root.value.ownerUserId === userId) {
      orgs.push({
        id: root.value.id,
        orgType: 'network_facilitator',
        relation: 'owner',
        isDefault: false,
      });
    }
    for (const org of owned.value) if (org.status === 'active') orgs.push(ownedOrg(org));
    return withGrants({ userId, userType: 'admin', active: orgs.length > 0, orgs });
  }

  /**
   * A coordinator named by the token's `aggregator_id` claim, accepted only
   * when the recorded login of that coordinator is this token's subject: the
   * database, not a token claim, is the authority for who a coordinator is.
   * An unlinked coordinator (login not recorded yet) resolves to nothing here.
   */
  private async claimedCoordinator(id: string, subject: string): Promise<ActorResult> {
    const linked = await getIdentityStore().subjectOf(id, IDP_PROVIDER);
    if (!linked.ok) return unavailable(linked.error.message);
    if (linked.value !== subject) return { ok: true, value: null };
    return this.coordinator(id);
  }

  private async coordinator(id: string): Promise<ActorResult> {
    const row = await getAggregatorStore().findById(id);
    if (!row.ok) return unavailable(row.error.message);
    if (!row.value) return { ok: true, value: null };
    const actor = coordinatorActor(row.value);
    // RBAC R3: the organisation's own PermissionSet caps the coordinator.
    const memberOrg = actor.orgs[0];
    if (memberOrg) {
      const org = await getAggregatorOrgStore().findById(memberOrg.id);
      if (!org.ok) return unavailable(org.error.message);
      memberOrg.permissionSet = org.value?.permissionSet ?? null;
    }
    return withGrants(actor);
  }
}
