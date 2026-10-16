/**
 * In-memory RBAC catalogue (`@aggregator-dpg/api`) for unit tests.
 *
 * Mirrors the Postgres store: a sync upserts the permissions and marks every
 * other one deprecated, replaces the built-in roles and keeps custom ones; the
 * revision changes on every write. `failWith` makes later
 * calls fail, to test boot and refresh paths.
 */

import type { PermissionDefinition, RoleDefinition } from '@aggregator-dpg/rbac/interface';
import {
  RbacCatalogueBase,
  type CatalogueSnapshot,
  type CatalogueStoreError,
  type CatalogueStoreResult,
  type StoredPermission,
  type SyncResult,
} from './interface.js';

/** Array-backed {@link RbacCatalogueBase}; `syncs` lists every sync source. */
export class InMemoryRbacCatalogue extends RbacCatalogueBase {
  permissions: StoredPermission[] = [];
  private roles: RoleDefinition[] = [];
  private rev = 0;
  private failure: CatalogueStoreError | null = null;
  readonly syncs: string[] = [];

  /** Makes every later call fail with `error` (`null` restores). */
  failWith(error: CatalogueStoreError | null): void {
    this.failure = error;
  }

  /**
   * Replaces the stored roles, as an edit would (test setup only).
   *
   * @param roles - The new roles.
   */
  setRoles(roles: RoleDefinition[]): void {
    this.roles = structuredClone(roles);
    this.rev += 1;
  }

  /** The stored roles (a copy). */
  storedRoles(): RoleDefinition[] {
    return structuredClone(this.roles);
  }

  private fail(): CatalogueStoreResult<never> | null {
    return this.failure ? { ok: false, error: this.failure } : null;
  }

  /** {@inheritDoc RbacCatalogueBase.sync} */
  async sync(
    permissions: PermissionDefinition[],
    builtinRoles: RoleDefinition[],
    source: string,
  ): Promise<CatalogueStoreResult<SyncResult>> {
    const failed = this.fail();
    if (failed) return failed;
    const current = new Set(permissions.map((p) => p.key as string));
    const dropped = this.permissions.filter((p) => !current.has(p.key));
    const retired = dropped.filter((p) => !p.deprecated).length;
    this.permissions = [
      ...permissions.map((p) => ({ ...p, deprecated: false })),
      ...dropped.map((p) => ({ ...p, deprecated: true })),
    ];
    const custom = this.roles.filter((r) => !r.isBuiltin);
    const before = JSON.stringify(this.roles.filter((r) => r.isBuiltin));
    this.roles = [...structuredClone(builtinRoles), ...custom];
    const changed = before === JSON.stringify(builtinRoles) ? 0 : builtinRoles.length;
    if (changed > 0) this.rev += 1;
    this.syncs.push(source);
    return { ok: true, value: { changed, retired, keptInUse: [] } };
  }

  /** {@inheritDoc RbacCatalogueBase.load} */
  async load(): Promise<CatalogueStoreResult<CatalogueSnapshot>> {
    return (
      this.fail() ?? {
        ok: true,
        value: { roles: structuredClone(this.roles), revision: `r${this.rev}` },
      }
    );
  }

  /** {@inheritDoc RbacCatalogueBase.revision} */
  async revision(): Promise<CatalogueStoreResult<string>> {
    return this.fail() ?? { ok: true, value: `r${this.rev}` };
  }

  /** {@inheritDoc RbacCatalogueBase.listPermissions} */
  async listPermissions(): Promise<CatalogueStoreResult<StoredPermission[]>> {
    return (
      this.fail() ?? {
        ok: true,
        value: structuredClone(this.permissions).sort((a, b) => a.key.localeCompare(b.key)),
      }
    );
  }

  /** Role keys with a live assignment, consulted by `deleteRole` (tests set it). */
  liveAssignments = new Set<string>();

  /** {@inheritDoc RbacCatalogueBase.createRole} */
  async createRole(
    role: RoleDefinition,
    _actorUserId: string,
  ): Promise<CatalogueStoreResult<{ created: boolean }>> {
    const failed = this.fail();
    if (failed) return failed;
    if (this.roles.some((r) => r.key === role.key)) return { ok: true, value: { created: false } };
    this.roles.push(structuredClone(role));
    this.rev += 1;
    return { ok: true, value: { created: true } };
  }

  /** {@inheritDoc RbacCatalogueBase.updateRole} */
  async updateRole(
    role: RoleDefinition,
    _actorUserId: string,
  ): Promise<CatalogueStoreResult<{ updated: boolean }>> {
    const failed = this.fail();
    if (failed) return failed;
    const i = this.roles.findIndex((r) => r.key === role.key && !r.isBuiltin);
    if (i < 0) return { ok: true, value: { updated: false } };
    this.roles[i] = structuredClone(role);
    this.rev += 1;
    return { ok: true, value: { updated: true } };
  }

  /** {@inheritDoc RbacCatalogueBase.deleteRole} */
  async deleteRole(
    key: string,
    _actorUserId: string,
  ): Promise<CatalogueStoreResult<'deleted' | 'in_use' | 'not_found'>> {
    const failed = this.fail();
    if (failed) return failed;
    const i = this.roles.findIndex((r) => r.key === key && !r.isBuiltin);
    if (i < 0) return { ok: true, value: 'not_found' };
    if (this.liveAssignments.has(key)) return { ok: true, value: 'in_use' };
    this.roles.splice(i, 1);
    this.rev += 1;
    return { ok: true, value: 'deleted' };
  }
}
