/**
 * Environment resolution utility for config-loader.
 *
 * Derives the active deployment environment from process environment variables
 * so callers do not need to thread it through manually.
 *
 * @module @aggregator-dpg/config-loader/env
 */

import type { Env } from './interface.js';

const VALID_ENVS = new Set<string>(['development', 'staging', 'production', 'test']);

/**
 * Resolves the active deployment environment.
 *
 * Resolution order:
 * 1. `CONFIG_ENV` — explicit config override
 * 2. `NODE_ENV` — standard Node.js convention
 * 3. `'development'` — safe fallback
 *
 * @returns The resolved Env value.
 * @throws {Error} If the resolved value is not a valid Env.
 */
export function resolveEnv(): Env {
  const raw = process.env['CONFIG_ENV'] ?? process.env['NODE_ENV'] ?? 'development';
  if (!VALID_ENVS.has(raw)) {
    throw new Error(
      `Invalid environment "${raw}". Must be one of: ${[...VALID_ENVS].join(', ')}. ` +
        `Set CONFIG_ENV or NODE_ENV to a valid value.`,
    );
  }
  return raw as Env;
}
