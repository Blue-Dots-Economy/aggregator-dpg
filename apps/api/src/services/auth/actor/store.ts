/**
 * Store-backed actor resolver (`@aggregator-dpg/api`).
 *
 * Reads the coordinator, org and identity stores, so it works with Postgres
 * and with the in-memory stores used in tests.
 */

import { getUserStore, type Coordinator } from '../../user-store/index.js';
import { getOrganisationStore, type Organisation } from '../../organisation-store/index.js';
import { getIdentityStore } from '../../identity-store/index.js';
import { getRoleStore } from '../../role-store/index.js';
import { getRbacRuntime } from '../../authz/runtime.js';
import { IDP_PROVIDER } from '../../idp-admin/provider.js';
import { logActing, resolveActingAccount } from '../acting.js';
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

const actingInvalid = (message: string): ActorResult => ({
  ok: false,
  error: { code: 'ACTING_ACCOUNT_INVALID', message },
});

/** The coordinator actor of a stored coordinator row. */
function coordinatorActor(row: Coordinator): Actor {
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
function ownedOrg(org: Organisation): ActorOrg {
  return {
    id: org.id,
    orgType: 'aggregator',
    relation: 'owner',
    isDefault: org.isDefault,
  };
}

/**
 * Adds the user's live additional roles (`user_role`) to a resolved actor.
 * Skipped when RBAC is off, so no role query runs per request.
 *
 * @returns The actor (with `roles` when RBAC is on), or `UNAVAILABLE` when the store failed.
 */
async function withRoles(actor: Actor): Promise<ActorResult> {
  if (!getRbacRuntime()) return { ok: true, value: actor };
  const live = await getRoleStore().listLive(actor.userId, new Date());
  if (!live.ok) return unavailable(live.error.message);
  return {
    ok: true,
    value: {
      ...actor,
      roles: live.value.map((r) => ({
        roleKey: r.roleKey,
        orgId: r.orgId,
        expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
      })),
    },
  };
}

/** Resolves actors from the application's stores. */
export class StoreActorResolver extends ActorResolverBase {
  async resolve(input: ResolveActorInput): Promise<ActorResult> {
    const actingId = input.actingAccountId?.toLowerCase();
    if (input.userId) {
      if (actingId !== undefined && actingId !== input.userId.toLowerCase()) {
        logActing('CLAIM_MISMATCH');
        return actingInvalid('acting account differs from the user_id claim');
      }
      return this.claimedCoordinator(input.userId, input.subject);
    }
    if (actingId !== undefined) return this.actingCoordinator(input.subject, actingId);

    // Without the claim and the header, a login that links an admin account
    // resolves to the admin; a coordinator-only login to the coordinator.
    const linked = await getIdentityStore().userOf(IDP_PROVIDER, input.subject);
    if (!linked.ok) return unavailable(linked.error.message);
    if (!linked.value) return { ok: true, value: null };
    return this.byUserId(linked.value);
  }

  /**
   * Resolves the owner's own coordinator account named by `x-acting-account`,
   * after the checks of {@link resolveActingAccount}.
   */
  private async actingCoordinator(subject: string, accountId: string): Promise<ActorResult> {
    const acting = await resolveActingAccount(subject, accountId);
    if (!acting.success) {
      logActing(acting.error.code);
      return acting.error.code === 'UNAVAILABLE'
        ? unavailable(acting.error.message)
        : actingInvalid(acting.error.message);
    }
    logActing(null);
    return withRoles(coordinatorActor(acting.value));
  }

  /**
   * The actor of an account by its id, with no token: a coordinator when the
   * id is one, else an admin and the active organisations it owns. Used to
   * keep the token's `roles` claim in step with the database.
   *
   * @param userId - The account (`users.id`).
   * @returns The actor; null when no such account; `UNAVAILABLE` when a store failed.
   */
  async byUserId(userId: string): Promise<ActorResult> {
    const asCoordinator = await getUserStore().findById(userId);
    if (!asCoordinator.ok) return unavailable(asCoordinator.error.message);
    if (asCoordinator.value) return this.coordinator(userId);
    return this.admin(userId);
  }

  /** An admin account and the active organisations it owns. */
  private async admin(userId: string): Promise<ActorResult> {
    const orgStore = getOrganisationStore();
    const [owned, root] = await Promise.all([orgStore.listOwnedBy(userId), orgStore.findRoot()]);
    if (!owned.ok) return unavailable(owned.error.message);
    if (!root.ok) return unavailable(root.error.message);

    const orgs: ActorOrg[] = [];
    if (root.value?.ownerUserId === userId) {
      orgs.push({
        id: root.value.id,
        orgType: 'network_facilitator',
        relation: 'owner',
        isDefault: false,
      });
    }
    for (const org of owned.value) if (org.status === 'active') orgs.push(ownedOrg(org));
    return withRoles({ userId, userType: 'admin', active: orgs.length > 0, orgs });
  }

  /**
   * Resolves the coordinator named by the `user_id` claim.
   *
   * Accepted only when that coordinator's recorded login is this token's
   * subject. A coordinator with no recorded login resolves to nothing.
   */
  private async claimedCoordinator(id: string, subject: string): Promise<ActorResult> {
    const linked = await getIdentityStore().subjectOf(id, IDP_PROVIDER);
    if (!linked.ok) return unavailable(linked.error.message);
    if (linked.value !== subject) return { ok: true, value: null };
    return this.coordinator(id);
  }

  private async coordinator(id: string): Promise<ActorResult> {
    const row = await getUserStore().findById(id);
    if (!row.ok) return unavailable(row.error.message);
    if (!row.value) return { ok: true, value: null };
    return withRoles(coordinatorActor(row.value));
  }
}
