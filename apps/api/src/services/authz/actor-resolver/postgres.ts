/**
 * Postgres actor resolver (`@aggregator-dpg/api`, RBAC R0).
 *
 * Reads today's schema: a coordinator by `users.id` (the `aggregator_id`
 * claim) with its `parent_org_id`; an admin through `user_identities` with the
 * active orgs it owns (`aggregator_orgs.owner_user_id`). Logs SQLSTATE only —
 * never the driver message, which carries query parameters.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { aggregatorOrgs, userIdentities, users } from '../../../db/schema.js';
import { pgErrorCode } from '../../../db/pg-error.js';
import { logger } from '../../../logger.js';
import { IDP_PROVIDER } from '../../idp-admin/provider.js';
import {
  ActorResolverBase,
  DEFAULT_ORG_PLACEHOLDER,
  type ActorResolverResult,
  type ResolvedActor,
  type TokenIdentity,
} from './interface.js';

/** Postgres-backed {@link ActorResolverBase}. */
export class PostgresActorResolver extends ActorResolverBase {
  /** {@inheritDoc ActorResolverBase.resolve} */
  async resolve(identity: TokenIdentity): Promise<ActorResolverResult<ResolvedActor | null>> {
    try {
      const db = getDb();
      let userId = identity.aggregatorId;
      if (!userId) {
        const [link] = await db
          .select({ userId: userIdentities.userId })
          .from(userIdentities)
          .where(
            and(
              eq(userIdentities.provider, IDP_PROVIDER),
              eq(userIdentities.subject, identity.subject),
            ),
          );
        userId = link?.userId;
      }
      if (!userId) return { ok: true, value: null };

      const [user] = await db
        .select({ userType: users.userType, status: users.status, parentOrgId: users.parentOrgId })
        .from(users)
        .where(eq(users.id, userId));
      if (!user) return { ok: true, value: null };

      if (user.userType === 'coordinator') {
        return {
          ok: true,
          value: {
            userId,
            userType: 'coordinator',
            active: user.status === 'active',
            orgs: [
              {
                id: user.parentOrgId ?? DEFAULT_ORG_PLACEHOLDER,
                orgType: 'aggregator',
                relation: 'member',
                permissionSet: null,
              },
            ],
            grants: [],
          },
        };
      }

      const owned = await db
        .select({ id: aggregatorOrgs.id })
        .from(aggregatorOrgs)
        .where(and(eq(aggregatorOrgs.ownerUserId, userId), eq(aggregatorOrgs.status, 'active')));
      return {
        ok: true,
        value: {
          userId,
          userType: 'admin',
          active: owned.length > 0,
          orgs: owned.map((o) => ({
            id: o.id,
            orgType: 'aggregator' as const,
            relation: 'owner' as const,
            permissionSet: null,
          })),
          grants: [],
        },
      };
    } catch (e) {
      return dbFailure('actorResolver.resolve', e);
    }
  }

  /** {@inheritDoc ActorResolverBase.orgChain} */
  async orgChain(orgId: string): Promise<ActorResolverResult<string[]>> {
    // `aggregator_orgs` has no parent until refactor Phase 3 adds
    // `organisations.parent_id`; the chain is the organisation alone.
    return { ok: true, value: [orgId] };
  }
}

/**
 * Logs a driver failure (SQLSTATE only) and maps it to `DB_UNAVAILABLE`.
 *
 * @param op - Operation name for the log entry.
 * @param e - The thrown error.
 * @returns The failure result.
 */
function dbFailure(op: string, e: unknown): ActorResolverResult<never> {
  logger.warn({ operation: op, status: 'failure', sqlstate: pgErrorCode(e) });
  return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'database unavailable' } };
}
