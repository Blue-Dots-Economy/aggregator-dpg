/**
 * Postgres RBAC catalogue (`@aggregator-dpg/api`, migration 0030).
 *
 * `sync` writes the permissions and the built-in roles in one transaction
 * under an advisory lock, so replicas starting together sync once. `load`
 * reads every role, its permissions and the revision in one read-only
 * REPEATABLE READ transaction, so the snapshot and its revision always match.
 * The revision is an md5 over `role` and `role_permission`, so any insert,
 * update or delete changes it. Logs SQLSTATE only — never the driver message.
 */

import { and, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type {
  BaseFor,
  Capability,
  OrgType,
  PermissionDefinition,
  RoleDefinition,
  UserType,
} from '@aggregator-dpg/rbac/interface';
import { compareCodeUnits } from '@aggregator-dpg/rbac';
import { getDb } from '../../db/client.js';
import { iamAudit, permission, role, rolePermission, userRole } from '../../db/schema.js';
import { pgErrorCode } from '../../db/pg-error.js';
import { logger } from '../../logger.js';
import {
  RbacCatalogueBase,
  type CatalogueSnapshot,
  type CatalogueStoreResult,
  type StoredPermission,
  type SyncResult,
} from './interface.js';

/** Advisory-lock key for the sync, shared by every replica. */
const SYNC_LOCK = sql`select pg_advisory_xact_lock(hashtext('aggregator-dpg:rbac-catalogue-sync'))`;

/** Checksum of the role tables; any row change moves it. */
const REVISION = sql`select md5(
  coalesce((select string_agg(concat_ws(':', key, name, description, is_builtin, account_type,
      coalesce(base_for, ''), array_to_string(assignable_org_types, ','), coalesce(assigned_by, ''),
      coalesce(max_days::text, '')), '|' order by key) from role), '')
  || '#' ||
  coalesce((select string_agg(role_key || '=' || permission_key, '|' order by role_key, permission_key)
      from role_permission), '')
) as revision`;

/** Logs a driver failure (SQLSTATE only) and maps it to `DB_UNAVAILABLE`. */
function dbFailure(op: string, e: unknown): CatalogueStoreResult<never> {
  logger.warn({ operation: op, status: 'failure', sqlstate: pgErrorCode(e) });
  return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'database unavailable' } };
}

/** The `revision` column of a `REVISION` result. */
function revisionOf(result: { rows: Array<Record<string, unknown>> }): string {
  return String(result.rows[0]?.['revision'] ?? '');
}

/** A role's stored columns. */
function roleValues(r: RoleDefinition) {
  return {
    key: r.key,
    name: r.name,
    description: r.description,
    isBuiltin: r.isBuiltin,
    accountType: r.accountType,
    baseFor: r.baseFor,
    assignableOrgTypes: r.assignableOrgTypes,
    assignedBy: r.assignedBy,
    maxDays: r.maxDays,
  };
}

/** Postgres-backed {@link RbacCatalogueBase}. */
export class PostgresRbacCatalogue extends RbacCatalogueBase {
  /** {@inheritDoc RbacCatalogueBase.sync} */
  async sync(
    permissions: PermissionDefinition[],
    builtinRoles: RoleDefinition[],
    source: string,
  ): Promise<CatalogueStoreResult<SyncResult>> {
    try {
      const result = await getDb().transaction(async (tx) => {
        await tx.execute(SYNC_LOCK);
        const before = revisionOf(await tx.execute(REVISION));
        let changed = 0;
        let retired = 0;

        // Permissions: upsert the code's, deprecate the rest (never delete:
        // role_permission and role.assigned_by reference them).
        for (const p of permissions) {
          const res = await tx
            .insert(permission)
            .values({ ...p, deprecated: false })
            .onConflictDoUpdate({
              target: permission.key,
              set: {
                resource: p.resource,
                action: p.action,
                description: p.description,
                sensitive: p.sensitive,
                deprecated: false,
              },
            })
            .returning({ key: permission.key });
          changed += res.length;
        }
        const keys = permissions.map((p) => p.key);
        const dep = await tx
          .update(permission)
          .set({ deprecated: true })
          .where(and(notInArray(permission.key, keys), eq(permission.deprecated, false)))
          .returning({ key: permission.key });
        retired += dep.length;

        // Built-in roles: upsert each with exactly its permissions.
        for (const r of builtinRoles) {
          await tx
            .insert(role)
            .values(roleValues(r))
            .onConflictDoUpdate({
              target: role.key,
              set: { ...roleValues(r), updatedAt: new Date() },
            });
          await tx.delete(rolePermission).where(eq(rolePermission.roleKey, r.key));
          if (r.permissions.length > 0) {
            await tx
              .insert(rolePermission)
              .values(r.permissions.map((permissionKey) => ({ roleKey: r.key, permissionKey })));
          }
        }

        // Built-in roles gone from the file: remove unless assigned.
        const builtinKeys = builtinRoles.map((r) => r.key);
        const stale = await tx
          .select({ key: role.key })
          .from(role)
          .where(and(eq(role.isBuiltin, true), notInArray(role.key, builtinKeys)));
        const keptInUse: string[] = [];
        if (stale.length > 0) {
          const staleKeys = stale.map((s) => s.key);
          const used = await tx
            .selectDistinct({ key: userRole.roleKey })
            .from(userRole)
            .where(inArray(userRole.roleKey, staleKeys));
          const usedKeys = new Set(used.map((u) => u.key));
          const removable = staleKeys.filter((k) => !usedKeys.has(k));
          keptInUse.push(...staleKeys.filter((k) => usedKeys.has(k)));
          if (removable.length > 0) {
            await tx.delete(role).where(inArray(role.key, removable));
            retired += removable.length;
          }
        }

        const after = revisionOf(await tx.execute(REVISION));
        if (after !== before || retired > 0) {
          await tx.insert(iamAudit).values({
            event: 'catalogue.sync',
            actorUserId: null,
            details: {
              source,
              builtin_roles: builtinKeys,
              retired,
              kept_in_use: keptInUse,
            },
          });
        }
        return { changed: after === before ? 0 : changed, retired, keptInUse };
      });
      return { ok: true, value: result };
    } catch (e) {
      return dbFailure('rbacCatalogue.sync', e);
    }
  }

  /** {@inheritDoc RbacCatalogueBase.load} */
  async load(): Promise<CatalogueStoreResult<CatalogueSnapshot>> {
    try {
      const snapshot = await getDb().transaction(
        async (tx) => {
          const revision = revisionOf(await tx.execute(REVISION));
          const roles = await tx.select().from(role);
          const links = await tx.select().from(rolePermission);
          const permsOf = new Map<string, Capability[]>();
          for (const l of links) {
            permsOf.set(l.roleKey, [
              ...(permsOf.get(l.roleKey) ?? []),
              l.permissionKey as Capability,
            ]);
          }
          return {
            revision,
            roles: roles.map((r): RoleDefinition => ({
              key: r.key,
              name: r.name,
              description: r.description,
              isBuiltin: r.isBuiltin,
              accountType: r.accountType as UserType,
              baseFor: (r.baseFor as BaseFor | null) ?? null,
              assignableOrgTypes: r.assignableOrgTypes as OrgType[],
              assignedBy: (r.assignedBy as Capability | null) ?? null,
              maxDays: r.maxDays,
              permissions: (permsOf.get(r.key) ?? []).sort(compareCodeUnits),
            })),
          } satisfies CatalogueSnapshot;
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      return { ok: true, value: snapshot };
    } catch (e) {
      return dbFailure('rbacCatalogue.load', e);
    }
  }

  /** {@inheritDoc RbacCatalogueBase.createRole} */
  async createRole(
    r: RoleDefinition,
    actorUserId: string,
  ): Promise<CatalogueStoreResult<{ created: boolean }>> {
    try {
      const created = await getDb().transaction(async (tx) => {
        const rows = await tx
          .insert(role)
          .values(roleValues(r))
          .onConflictDoNothing({ target: role.key })
          .returning({ key: role.key });
        if (rows.length === 0) return false;
        if (r.permissions.length > 0) {
          await tx
            .insert(rolePermission)
            .values(r.permissions.map((permissionKey) => ({ roleKey: r.key, permissionKey })));
        }
        await tx.insert(iamAudit).values({
          event: 'catalogue.role.create',
          actorUserId,
          details: { role: r.key, permissions: r.permissions },
        });
        return true;
      });
      return { ok: true, value: { created } };
    } catch (e) {
      return dbFailure('rbacCatalogue.createRole', e);
    }
  }

  /** {@inheritDoc RbacCatalogueBase.updateRole} */
  async updateRole(
    r: RoleDefinition,
    actorUserId: string,
  ): Promise<CatalogueStoreResult<{ updated: boolean }>> {
    try {
      const updated = await getDb().transaction(async (tx) => {
        const rows = await tx
          .update(role)
          .set({ ...roleValues(r), updatedAt: new Date() })
          .where(and(eq(role.key, r.key), eq(role.isBuiltin, false)))
          .returning({ key: role.key });
        if (rows.length === 0) return false;
        await tx.delete(rolePermission).where(eq(rolePermission.roleKey, r.key));
        if (r.permissions.length > 0) {
          await tx
            .insert(rolePermission)
            .values(r.permissions.map((permissionKey) => ({ roleKey: r.key, permissionKey })));
        }
        await tx.insert(iamAudit).values({
          event: 'catalogue.role.update',
          actorUserId,
          details: { role: r.key, permissions: r.permissions },
        });
        return true;
      });
      return { ok: true, value: { updated } };
    } catch (e) {
      return dbFailure('rbacCatalogue.updateRole', e);
    }
  }

  /** {@inheritDoc RbacCatalogueBase.deleteRole} */
  async deleteRole(
    key: string,
    actorUserId: string,
  ): Promise<CatalogueStoreResult<'deleted' | 'in_use' | 'not_found'>> {
    try {
      const outcome = await getDb().transaction(async (tx) => {
        const [found] = await tx
          .select({ key: role.key })
          .from(role)
          .where(and(eq(role.key, key), eq(role.isBuiltin, false)))
          .for('update');
        if (!found) return 'not_found' as const;
        const live = await tx
          .select({ id: userRole.id })
          .from(userRole)
          .where(
            and(
              eq(userRole.roleKey, key),
              isNull(userRole.revokedAt),
              or(isNull(userRole.expiresAt), gt(userRole.expiresAt, new Date())),
            ),
          )
          .limit(1);
        if (live.length > 0) return 'in_use' as const;
        const past = await tx
          .delete(userRole)
          .where(eq(userRole.roleKey, key))
          .returning({ id: userRole.id });
        await tx.delete(role).where(eq(role.key, key));
        await tx.insert(iamAudit).values({
          event: 'catalogue.role.delete',
          actorUserId,
          details: { role: key, past_assignments_removed: past.length },
        });
        return 'deleted' as const;
      });
      return { ok: true, value: outcome };
    } catch (e) {
      return dbFailure('rbacCatalogue.deleteRole', e);
    }
  }

  /** {@inheritDoc RbacCatalogueBase.revision} */
  async revision(): Promise<CatalogueStoreResult<string>> {
    try {
      return { ok: true, value: revisionOf(await getDb().execute(REVISION)) };
    } catch (e) {
      return dbFailure('rbacCatalogue.revision', e);
    }
  }

  /** {@inheritDoc RbacCatalogueBase.listPermissions} */
  async listPermissions(): Promise<CatalogueStoreResult<StoredPermission[]>> {
    try {
      // Sorted here, not by the database's collation, so every store orders alike.
      const rows = await getDb().select().from(permission);
      return { ok: true, value: rows.sort((a, b) => a.key.localeCompare(b.key)) };
    } catch (e) {
      return dbFailure('rbacCatalogue.listPermissions', e);
    }
  }
}
