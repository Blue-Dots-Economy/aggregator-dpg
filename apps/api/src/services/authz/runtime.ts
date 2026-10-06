/**
 * RBAC runtime state for `@aggregator-dpg/api`: the mode, the validated
 * `rbac.yaml` and the decision engine, loaded once at boot.
 *
 * With `RBAC_MODE=off` nothing is loaded and no access check runs, so an
 * instance without an OPA sidecar or an `rbac.yaml` boots as before.
 */

import { join } from 'node:path';
import {
  OpaAuthorizer,
  loadRbacConfig,
  type AuthorizerBase,
  type RbacConfig,
} from '@aggregator-dpg/rbac';
import { resolveConfigDir, resolveConfigRoot } from '@aggregator-dpg/network-config/paths';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

/** `off`, `log` (decide and log, never block) or `enforce`. */
export type RbacMode = 'off' | 'log' | 'enforce';

/** Loaded RBAC state. */
export interface RbacRuntime {
  mode: Exclude<RbacMode, 'off'>;
  config: RbacConfig;
  authorizer: AuthorizerBase;
}

let runtime: RbacRuntime | null = null;

/**
 * Returns the `rbac.yaml` candidates, most specific first: the active
 * network/brand directory, the network directory, then the config root.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute candidate paths, without duplicates.
 */
export function rbacConfigCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = resolveConfigRoot(env);
  const active = resolveConfigDir(env);
  const network = join(root, env.AGGREGATOR_NETWORK?.trim() || 'blue_dot');
  return [
    ...new Set([join(active, 'rbac.yaml'), join(network, 'rbac.yaml'), join(root, 'rbac.yaml')]),
  ];
}

/**
 * Loads `rbac.yaml` and builds the OPA engine, unless `RBAC_MODE` is `off`.
 * Called once at boot; a broken `rbac.yaml` stops the process.
 *
 * @param mode - Defaults to `RBAC_MODE`.
 * @throws {ConfigError} When `rbac.yaml` is missing, unreadable or invalid.
 */
export async function initRbac(mode: RbacMode = config.RBAC_MODE): Promise<void> {
  if (mode === 'off') {
    runtime = null;
    logger.info({ operation: 'rbac.init', status: 'skipped', mode });
    return;
  }
  const loaded = await loadRbacConfig(rbacConfigCandidates());
  runtime = {
    mode,
    config: loaded.config,
    authorizer: new OpaAuthorizer({
      baseUrl: config.OPA_URL,
      timeoutMs: config.OPA_TIMEOUT_MS,
      retries: config.OPA_RETRIES,
      backoffMs: config.OPA_BACKOFF_MS,
    }),
  };
  logger.info({ operation: 'rbac.init', status: 'success', mode, config_path: loaded.path });
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
