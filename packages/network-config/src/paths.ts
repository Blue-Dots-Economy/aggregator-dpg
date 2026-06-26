/**
 * Pure path-resolution helpers that derive `AGGREGATOR_CONFIG_PATH` and
 * `SCHEMA_ROOT_DIR` from the two high-level brand selectors
 * (`AGGREGATOR_NETWORK` + `AGGREGATOR_BRAND`) so a deployment only needs to
 * set those two vars. Explicit `AGGREGATOR_CONFIG_PATH` / `SCHEMA_ROOT_DIR`
 * env vars are still honoured as overrides (backwards-compatible).
 *
 * Derivation rule:
 *   dir = `${CONFIG_ROOT}/${AGGREGATOR_NETWORK}[/${AGGREGATOR_BRAND}]`
 *   configPath = AGGREGATOR_CONFIG_PATH ?? `${dir}/aggregator.config.yaml`
 *   schemaRoot = SCHEMA_ROOT_DIR ?? `${dir}/schemas`
 *
 * @module packages/network-config/src/paths
 */

import path from 'node:path';

/**
 * Subset of `process.env` consulted by the path-resolution helpers.
 * Pass a custom object in tests instead of mutating `process.env`.
 */
export interface ConfigPathEnv {
  CONFIG_ROOT?: string;
  AGGREGATOR_NETWORK?: string;
  AGGREGATOR_BRAND?: string;
  AGGREGATOR_CONFIG_PATH?: string;
  SCHEMA_ROOT_DIR?: string;
}

/**
 * Resolves the active network/brand config directory from env vars.
 *
 * Defaults: `CONFIG_ROOT=/app/config`, `AGGREGATOR_NETWORK=blue_dot`.
 * Empty/whitespace `AGGREGATOR_BRAND` is treated as absent (no brand suffix).
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute directory path for the active network/brand config.
 */
export function resolveConfigDir(env: ConfigPathEnv = process.env): string {
  const root = env.CONFIG_ROOT?.trim() || '/app/config';
  const net = env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = env.AGGREGATOR_BRAND?.trim();
  return brand ? path.join(root, net, brand) : path.join(root, net);
}

/**
 * Resolves the aggregator config YAML path.
 *
 * Returns `AGGREGATOR_CONFIG_PATH` when explicitly set; otherwise derives
 * `<resolveConfigDir(env)>/aggregator.config.yaml`.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute path to `aggregator.config.yaml`.
 */
export function resolveConfigPath(env: ConfigPathEnv = process.env): string {
  return (
    env.AGGREGATOR_CONFIG_PATH?.trim() || path.join(resolveConfigDir(env), 'aggregator.config.yaml')
  );
}

/**
 * Resolves the schema root directory path.
 *
 * Returns `SCHEMA_ROOT_DIR` when explicitly set; otherwise derives
 * `<resolveConfigDir(env)>/schemas`.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute path to the `schemas/` directory.
 */
export function resolveSchemaRoot(env: ConfigPathEnv = process.env): string {
  return env.SCHEMA_ROOT_DIR?.trim() || path.join(resolveConfigDir(env), 'schemas');
}
