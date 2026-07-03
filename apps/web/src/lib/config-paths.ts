/**
 * Self-contained path-resolution helpers for the web app.
 *
 * Mirrors `@aggregator-dpg/network-config/paths` but is kept here to avoid
 * pulling the network-config package into the web bundle. Any logic change
 * must be applied to both files.
 *
 * Derivation rule:
 *   dir = `${CONFIG_ROOT}/${AGGREGATOR_NETWORK}[/${AGGREGATOR_BRAND}]`
 *   schemaRoot = SCHEMA_ROOT_DIR ?? `${dir}/schemas`
 *
 * @module apps/web/src/lib/config-paths
 */

import path from 'node:path';

/**
 * Resolves the active network/brand config directory from env vars.
 *
 * Defaults: `CONFIG_ROOT=/app/config`, `AGGREGATOR_NETWORK=blue_dot`.
 * Empty/whitespace `AGGREGATOR_BRAND` is treated as absent.
 *
 * @returns Absolute directory path for the active network/brand config.
 */
function resolveConfigDir(): string {
  const root = process.env.CONFIG_ROOT?.trim() || '/app/config';
  const net = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim();
  return brand ? path.join(root, net, brand) : path.join(root, net);
}

/**
 * Resolves the schema root directory path.
 *
 * Returns `SCHEMA_ROOT_DIR` when explicitly set; otherwise derives
 * `<resolveConfigDir()>/schemas` from `AGGREGATOR_NETWORK`/`AGGREGATOR_BRAND`.
 *
 * @returns Absolute path to the `schemas/` directory.
 */
export function resolveSchemaRoot(): string {
  return process.env.SCHEMA_ROOT_DIR?.trim() || path.join(resolveConfigDir(), 'schemas');
}
