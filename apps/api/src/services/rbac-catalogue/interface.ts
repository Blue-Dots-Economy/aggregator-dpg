/**
 * RBAC catalogue store contract (`@aggregator-dpg/api`, migration 0030).
 *
 * The `permission`, `role` and `role_permission` tables. At start the API
 * syncs the permissions from code and the built-in roles from
 * `config/rbac.yaml`; it then loads every role into a snapshot and re-reads a
 * checksum on a timer to reload when a role changed (design §5).
 *
 * Every method returns a `Result`-style union and never throws across the
 * service boundary.
 */

import type { PermissionDefinition, RoleDefinition } from '@aggregator-dpg/rbac/interface';

/** Errors a catalogue-store call can report. */
export type CatalogueStoreError = { code: 'DB_UNAVAILABLE'; message: string };

/** Result of a catalogue-store call. */
export type CatalogueStoreResult<T> =
  { ok: true; value: T } | { ok: false; error: CatalogueStoreError };

/** Every stored role and the checksum of the rows it was read from. */
export interface CatalogueSnapshot {
  roles: RoleDefinition[];
  /** Changes whenever a role or its permissions change. */
  revision: string;
}

/** What a sync changed. */
export interface SyncResult {
  /** Permissions and built-in roles written (0 when nothing differed). */
  changed: number;
  /** Permissions marked deprecated; built-in roles removed. */
  retired: number;
  /** Built-in roles no longer in the file but still assigned, so kept. */
  keptInUse: string[];
}

/**
 * One stored permission row. `key` is a plain string: a retired permission is
 * no longer a `Capability` in code.
 */
export interface StoredPermission {
  key: string;
  resource: string;
  action: string;
  description: string;
  sensitive: boolean;
  /** Removed from the code's catalogue; marked at sync, never deleted. */
  deprecated: boolean;
}

/** Abstract contract for the stored RBAC catalogue. */
export abstract class RbacCatalogueBase {
  /**
   * Brings the stored catalogue in line with the code and the file, in one
   * transaction under an advisory lock: every permission in `permissions` is
   * upserted and every other one marked deprecated; every built-in role in
   * `builtinRoles` is upserted with exactly its permissions; a built-in role
   * missing from the file is removed unless it is assigned. Custom roles are
   * never touched. Audited when anything changed.
   *
   * @param permissions - The code's permission catalogue.
   * @param builtinRoles - The built-in roles from `rbac.yaml`.
   * @param source - The `rbac.yaml` path, for the audit.
   * @returns What changed.
   */
  abstract sync(
    permissions: PermissionDefinition[],
    builtinRoles: RoleDefinition[],
    source: string,
  ): Promise<CatalogueStoreResult<SyncResult>>;

  /**
   * Reads every role with its permissions, and the revision, consistently.
   *
   * @returns The snapshot.
   */
  abstract load(): Promise<CatalogueStoreResult<CatalogueSnapshot>>;

  /**
   * Returns the revision; it changes whenever a role or its permissions do.
   *
   * @returns The current revision.
   */
  abstract revision(): Promise<CatalogueStoreResult<string>>;

  /**
   * Reads every stored permission, deprecated ones included, sorted by key.
   *
   * @returns The permission rows.
   */
  abstract listPermissions(): Promise<CatalogueStoreResult<StoredPermission[]>>;

  /**
   * Inserts a custom role with its permissions and audits it.
   *
   * @param role - The role (`isBuiltin` false).
   * @param actorUserId - Who created it.
   * @returns `created: false` when the key is taken.
   */
  abstract createRole(
    role: RoleDefinition,
    actorUserId: string,
  ): Promise<CatalogueStoreResult<{ created: boolean }>>;

  /**
   * Replaces a custom role's fields and permissions and audits it. Built-in
   * roles are never changed.
   *
   * @param role - The role's new definition (same key).
   * @param actorUserId - Who changed it.
   * @returns `updated: false` when no custom role has this key.
   */
  abstract updateRole(
    role: RoleDefinition,
    actorUserId: string,
  ): Promise<CatalogueStoreResult<{ updated: boolean }>>;

  /**
   * Deletes a custom role unless a live assignment uses it, and audits it.
   * Its past assignments are removed with it (their history is in
   * `iam_audit`). Built-in roles are never deleted.
   *
   * @param key - The role.
   * @param actorUserId - Who deleted it.
   * @returns `deleted`, `in_use` or `not_found`.
   */
  abstract deleteRole(
    key: string,
    actorUserId: string,
  ): Promise<CatalogueStoreResult<'deleted' | 'in_use' | 'not_found'>>;
}
