/**
 * Postgres actor resolver (`@aggregator-dpg/api`, RBAC R1).
 *
 * Reads the user-org model (migrations 0027–0029): a coordinator by `users.id`
 * (the `aggregator_id` claim) with its organisation (`users.org_id`); an
 * admin through `user_identities` with the active organisations it owns
 * (`organisations.org_owner`). Logs SQLSTATE only — never the driver message,
 * which carries query parameters.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { organisations, userIdentities, users } from '../../../db/schema.js';
import { pgErrorCode } from '../../../db/pg-error.js';
import { logger } from '../../../logger.js';
import { IDP_PROVIDER } from '../../idp-admin/provider.js';
import {
  ActorResolverBase,
  type ActorResolverResult,
  type ResolvedActor,
  type ResolvedOrg,
  type TokenIdentity,
} from './interface.js';

/** Upper bound on the ancestor walk; a deeper chain is a data fault, not a real tree. */
const MAX_CHAIN_DEPTH = 64;

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
        .select({ userType: users.userType, status: users.status, orgId: users.orgId })
        .from(users)
        .where(eq(users.id, userId));
      if (!user) return { ok: true, value: null };

      if (user.userType === 'coordinator') {
        const [org] = user.orgId
          ? await db
              .select({
                id: organisations.id,
                orgType: organisations.orgType,
                status: organisations.status,
              })
              .from(organisations)
              .where(eq(organisations.id, user.orgId))
          : [];
        const orgs: ResolvedOrg[] = org
          ? [{ id: org.id, orgType: org.orgType, relation: 'member', permissionSet: null }]
          : [];
        return {
          ok: true,
          value: {
            userId,
            userType: 'coordinator',
            active: user.status === 'active' && org?.status === 'active',
            orgs,
            grants: [],
          },
        };
      }

      const owned = await db
        .select({ id: organisations.id, orgType: organisations.orgType })
        .from(organisations)
        .where(and(eq(organisations.orgOwner, userId), eq(organisations.status, 'active')));
      return {
        ok: true,
        value: {
          userId,
          userType: 'admin',
          active: owned.length > 0,
          orgs: owned.map((o) => ({
            id: o.id,
            orgType: o.orgType,
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
    if (orgId.trim() === '') return { ok: true, value: [] };
    try {
      const res = await getDb().execute<{ id: string }>(sql`
        WITH RECURSIVE chain(id, parent_id, depth) AS (
          SELECT id, parent_id, 0 FROM organisations WHERE id = ${orgId}::uuid
          UNION ALL
          SELECT o.id, o.parent_id, c.depth + 1
            FROM organisations o JOIN chain c ON o.id = c.parent_id
           WHERE c.depth < ${MAX_CHAIN_DEPTH}
        )
        SELECT id FROM chain ORDER BY depth`);
      return { ok: true, value: res.rows.map((r) => r.id) };
    } catch (e) {
      return dbFailure('actorResolver.orgChain', e);
    }
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
