/**
 * RBAC runtime state for `@aggregator-dpg/api`: the mode, the role snapshot
 * and the decision engine (design §5).
 *
 * The built-in roles and the permission catalogue are seeded into the database
 * by migration `0031_rbac_seed.sql`; with RBAC on the API just loads every
 * role (built-in and custom) into a snapshot. A timer re-reads the catalogue
 * revision and reloads when it changed, so a custom-role write on another
 * instance propagates here. An invalid catalogue stops the boot; on a later
 * refresh the last good snapshot stays in place, so an edit can never widen or
 * drop access by accident.
 *
 * With `RBAC_MODE=off` nothing is loaded and no access check runs, so an
 * instance without an OPA sidecar boots as before.
 */

import {
  OpaAuthorizer,
  assertRoleCatalogue,
  indexRoles,
  type AuthorizerBase,
  type RoleIndex,
} from '@aggregator-dpg/rbac';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getRbacCatalogue, type RbacCatalogueBase } from '../rbac-catalogue/index.js';

/** `off`, `log` (decide and log, never block) or `enforce`. */
export type RbacMode = 'off' | 'log' | 'enforce';

/** Loaded RBAC state. */
export interface RbacRuntime {
  mode: Exclude<RbacMode, 'off'>;
  /** Every role (built-in and custom), indexed. */
  roles: RoleIndex;
  authorizer: AuthorizerBase;
  /** The catalogue revision the snapshot was read at; absent when set by a test. */
  catalogueRevision?: string;
}

/** What a refresh did. */
export type RefreshOutcome = 'off' | 'unchanged' | 'reloaded' | 'failed';

let runtime: RbacRuntime | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<RefreshOutcome> | null = null;

/** A store failure at boot is a configuration problem: the API cannot decide. */
function unavailable(op: string, message: string): ConfigError {
  return new ConfigError(`RBAC catalogue unavailable (${op})`, {
    code: 'RBAC_CATALOGUE_UNAVAILABLE',
    details: { operation: op, message },
  });
}

/**
 * Loads every role and checks the role rules.
 *
 * @param store - The catalogue store.
 * @returns The indexed roles and their revision.
 * @throws {ConfigError} `RBAC_CATALOGUE_UNAVAILABLE` or `RBAC_CONFIG_INVALID`.
 */
async function loadSnapshot(
  store: RbacCatalogueBase,
): Promise<{ roles: RoleIndex; revision: string }> {
  const loaded = await store.load();
  if (!loaded.ok) throw unavailable('load', loaded.error.message);
  assertRoleCatalogue(loaded.value.roles, `database catalogue (revision ${loaded.value.revision})`);
  return { roles: indexRoles(loaded.value.roles), revision: loaded.value.revision };
}

/**
 * Loads the role snapshot and builds the OPA engine, unless `RBAC_MODE` is
 * `off`; then starts the refresh timer. Called once at boot. The built-in
 * roles and the permission catalogue are already in the database (migration
 * `0031_rbac_seed.sql`), so there is no file load and no sync here.
 *
 * @param mode - Defaults to `RBAC_MODE`.
 * @param refreshMs - Refresh interval; defaults to `RBAC_CATALOGUE_REFRESH_MS`,
 *   `0` disables the timer.
 * @throws {ConfigError} When the catalogue cannot be read or is invalid.
 */
export async function initRbac(
  mode: RbacMode = config.RBAC_MODE,
  refreshMs: number = config.RBAC_CATALOGUE_REFRESH_MS,
): Promise<void> {
  stopRbacRefresh();
  if (mode === 'off') {
    runtime = null;
    logger.info({ operation: 'rbac.init', status: 'skipped', mode });
    return;
  }
  const store = getRbacCatalogue();
  const snapshot = await loadSnapshot(store);
  runtime = {
    mode,
    roles: snapshot.roles,
    catalogueRevision: snapshot.revision,
    authorizer: new OpaAuthorizer({
      baseUrl: config.OPA_URL,
      timeoutMs: config.OPA_TIMEOUT_MS,
      retries: config.OPA_RETRIES,
      backoffMs: config.OPA_BACKOFF_MS,
    }),
  };
  if (refreshMs > 0) {
    timer = setInterval(() => void refreshRbacCatalogue(), refreshMs);
    timer.unref();
  }
  logger.info({
    operation: 'rbac.init',
    status: 'success',
    mode,
    roles: snapshot.roles.byKey.size,
    catalogue_revision: snapshot.revision,
    refresh_ms: refreshMs,
  });
}

/** One refresh: reload only when the revision changed; keep the last good snapshot. */
async function refreshOnce(): Promise<RefreshOutcome> {
  const current = runtime;
  if (!current) return 'off';
  const store = getRbacCatalogue();
  const revision = await store.revision();
  if (!revision.ok) {
    logger.warn({
      operation: 'rbac.catalogue.refresh',
      status: 'failure',
      error: revision.error.code,
    });
    return 'failed';
  }
  if (revision.value === current.catalogueRevision) return 'unchanged';
  try {
    const snapshot = await loadSnapshot(store);
    if (runtime === current) {
      runtime = { ...current, roles: snapshot.roles, catalogueRevision: snapshot.revision };
    }
    logger.info({
      operation: 'rbac.catalogue.refresh',
      status: 'success',
      from_revision: current.catalogueRevision,
      to_revision: snapshot.revision,
    });
    return 'reloaded';
  } catch (err) {
    logger.error({
      operation: 'rbac.catalogue.refresh',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof ConfigError ? err.code : 'unknown',
      kept_revision: current.catalogueRevision,
    });
    return 'failed';
  }
}

/**
 * Reloads the snapshot when the catalogue revision changed. Runs on the timer
 * and right after a role write on this replica; overlapping calls share one
 * run.
 *
 * @returns What the refresh did.
 */
export function refreshRbacCatalogue(): Promise<RefreshOutcome> {
  refreshing ??= refreshOnce().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Stops the refresh timer (shutdown, re-init, tests). */
export function stopRbacRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Returns the loaded state, or null when RBAC is off.
 *
 * @returns The runtime, or null.
 */
export function getRbacRuntime(): RbacRuntime | null {
  return runtime;
}

/** Test helper — replace the runtime. */
export function _setRbacRuntime(r: RbacRuntime | null): void {
  runtime = r;
}
