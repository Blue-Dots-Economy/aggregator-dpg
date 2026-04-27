/**
 * Composite Zod validation for the merged config tree.
 *
 * Builds a single z.object schema from all registered packages, runs it
 * against the post-interpolation config, and throws a single ConfigError
 * that lists every failing field rather than stopping at the first.
 *
 * @module @aggregator-dpg/config-loader/validate
 */

import { z } from 'zod';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import type { RegisteredPackage } from './discovery.js';

/**
 * Returns true if `schema` is a genuine Zod schema (has `_def`).
 * Duck-typed test fixtures that lack `_def` fall back to z.unknown().
 */
function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return (
    schema !== null && typeof schema === 'object' && '_def' in (schema as Record<string, unknown>)
  );
}

/**
 * Builds a strict composite Zod schema from all registered packages.
 *
 * The resulting schema is `z.object({ <configKey>: <packageSchema>, ... }).strict()`.
 * Unknown top-level keys (not owned by any package) are rejected.
 *
 * Schemas that are not genuine Zod instances (e.g., test doubles) fall back to
 * `z.unknown()` so they pass validation without type-checking.
 *
 * @param registry - Map of discovered packages keyed by configKey.
 * @returns Composite strict Zod object schema.
 */
export function buildCompositeSchema(
  registry: ReadonlyMap<string, RegisteredPackage>,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, pkg] of registry) {
    shape[key] = isZodSchema(pkg.configSchema) ? pkg.configSchema : z.unknown();
  }
  return z.object(shape).strict();
}

/**
 * Validates the merged config tree against all per-package Zod schemas.
 *
 * If the registry is empty, validation is skipped and the config is returned as-is
 * (no packages have registered schemas yet).
 *
 * All validation errors are collected before throwing so every offending field
 * is reported in a single error rather than stopping at the first.
 *
 * @param config - Merged and interpolated config tree.
 * @param registry - Map of discovered packages keyed by configKey.
 * @returns Validated (and potentially Zod-coerced) config tree.
 * @throws {ConfigError} With code CONFIG_VALIDATION_ERROR if any field is invalid.
 */
export function validateConfig(
  config: Record<string, unknown>,
  registry: ReadonlyMap<string, RegisteredPackage>,
): Record<string, unknown> {
  if (registry.size === 0) return config;

  const schema = buildCompositeSchema(registry);
  const result = schema.safeParse(config);

  if (result.success) {
    return result.data as Record<string, unknown>;
  }

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  throw new ConfigError(
    `Config validation failed with ${issues.length} error(s):\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    {
      code: 'CONFIG_VALIDATION_ERROR',
      details: { issues },
    },
  );
}
