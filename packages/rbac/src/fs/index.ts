/**
 * Filesystem loader for `rbac.yaml` (`@aggregator-dpg/rbac`).
 *
 * The caller passes candidate paths, most specific first (brand, network,
 * config root); the first file that exists wins, with no merging, matching
 * how the rest of `config/` layers.
 *
 * @module @aggregator-dpg/rbac/fs
 */

import { access, readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { parseRbacConfig } from '../rbac-config.js';
import type { RbacConfig } from '../rbac-config.js';

/** A loaded config and the file it came from. */
export interface LoadedRbacConfig {
  config: RbacConfig;
  path: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads and validates the first `rbac.yaml` that exists.
 *
 * @param candidates - Absolute paths, most specific first.
 * @returns The validated config and its path.
 * @throws {ConfigError} `RBAC_CONFIG_NOT_FOUND` when no candidate exists,
 *   `RBAC_CONFIG_READ_ERROR` when the file cannot be read or parsed, or
 *   `RBAC_CONFIG_INVALID` when it fails validation.
 */
export async function loadRbacConfig(candidates: readonly string[]): Promise<LoadedRbacConfig> {
  for (const path of candidates) {
    if (!(await exists(path))) continue;
    let raw: unknown;
    try {
      raw = parseYaml(await readFile(path, 'utf8'));
    } catch (err) {
      throw new ConfigError(`Failed to read or parse rbac config at ${path}`, {
        code: 'RBAC_CONFIG_READ_ERROR',
        details: { path, cause: String(err) },
      });
    }
    return { config: parseRbacConfig(raw, path), path };
  }
  throw new ConfigError('No rbac.yaml found', {
    code: 'RBAC_CONFIG_NOT_FOUND',
    details: { candidates: [...candidates] },
  });
}
