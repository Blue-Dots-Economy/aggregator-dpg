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
  AGGREGATOR_NETWORK_SOURCE?: string;
  AGGREGATOR_CONSENT_SOURCE?: string;
}

/**
 * Resolves the deploy-time override for the signalstack `network.json`
 * URL. When `AGGREGATOR_NETWORK_SOURCE` is set (non-empty after trim)
 * it wins over `aggregator.network.source` from the YAML, letting a
 * deployment swap the schema source (e.g. via a Kubernetes ConfigMap)
 * without rebuilding the image or editing the mounted config (#512).
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns The override URL, or `undefined` when unset/blank.
 */
export function resolveNetworkSourceOverride(env: ConfigPathEnv = process.env): string | undefined {
  const value = env.AGGREGATOR_NETWORK_SOURCE?.trim();
  return value ? value : undefined;
}

/**
 * Resolves the deploy-time override for the participant `consent.json` URL.
 * When `AGGREGATOR_CONSENT_SOURCE` is set (non-empty after trim) it wins over
 * `aggregator.network.consent_source` from the YAML — the consent-document
 * analogue of {@link resolveNetworkSourceOverride}.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns The override URL, or `undefined` when unset/blank.
 */
export function resolveConsentSourceOverride(env: ConfigPathEnv = process.env): string | undefined {
  const value = env.AGGREGATOR_CONSENT_SOURCE?.trim();
  return value ? value : undefined;
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

/**
 * Resolves the active network and optional brand identifiers from env vars.
 *
 * These are the two high-level selectors used by both the web layer (to
 * determine which consent content to display) and the API layer (to determine
 * which consent version to record in the ledger). Using this helper in both
 * places guarantees the displayed content and the recorded version always
 * match the same config file.
 *
 * Defaults: `AGGREGATOR_NETWORK=blue_dot` (single-sourced from
 * {@link resolveConfigDir}). Empty/whitespace `AGGREGATOR_BRAND` is treated
 * as absent (`undefined`) — the same rule applied by `resolveConfigDir`.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns `{ network, brand? }` — `brand` is `undefined` when not set.
 */
/**
 * Returns the candidate locations of an aggregator schema file inside a
 * `config/` root, most specific first.
 *
 * Registration schemas vary per deployment — the UP-GZB instance captures
 * organisation type / sub-type / management type and a `service_provider`
 * aggregator type that Purple Dot and Dharwad must not be asked for. Callers
 * try each returned path in order and use the first that exists, so a network
 * (or network+brand) may override the shared default by placing a **complete**
 * copy of the file at `<network>[/<brand>]/schemas/aggregator/<file>`.
 *
 * These are complete files, not partials: the registration validator compiles
 * one JSON Schema with Ajv and there is no merge layer, so a partial override
 * would drop every field it did not restate.
 *
 * Logic change here must be mirrored in `apps/web/src/lib/config-paths.ts`,
 * which deliberately does not depend on this package.
 *
 * @param file - Bare schema file name, e.g. `registration.v1.json`.
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Root-relative paths, most specific first.
 */
export function aggregatorSchemaRelPaths(file: string, env: ConfigPathEnv = process.env): string[] {
  const net = env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = env.AGGREGATOR_BRAND?.trim();
  // Most specific first. A single expression rather than repeated `push` calls,
  // so the ordering is readable in one glance and cannot be reordered by accident.
  const relPath = (...prefix: string[]): string =>
    path.join(...prefix, 'schemas', 'aggregator', file);
  return brand ? [relPath(net, brand), relPath(net), relPath()] : [relPath(net), relPath()];
}

export function resolveActiveNetwork(env: ConfigPathEnv = process.env): {
  network: string;
  brand?: string;
} {
  const network = env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brandRaw = env.AGGREGATOR_BRAND?.trim();
  const result: { network: string; brand?: string } = { network };
  if (brandRaw) result.brand = brandRaw;
  return result;
}
