/**
 * Environment resolution utility for config-loader.
 *
 * Derives the active deployment environment from process environment variables
 * so callers do not need to thread it through manually.
 *
 * @module @aggregator-dpg/config-loader/env
 */

import { z } from 'zod';
import type { Env } from './interface.js';

/** Every valid deployment environment. */
const VALID_ENVS = [
  'development',
  'staging',
  'production',
  'test',
] as const satisfies readonly Env[];

const EnvSchema = z.enum(VALID_ENVS);

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
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment "${raw}". Must be one of: ${VALID_ENVS.join(', ')}. ` +
        `Set CONFIG_ENV or NODE_ENV to a valid value.`,
    );
  }
  return parsed.data;
}
