/**
 * Env-var interpolation for config trees.
 *
 * Walks the merged config tree and replaces all `${VAR}` and `${VAR:-default}`
 * placeholders in string values with the corresponding process.env entry.
 * Interpolation runs after YAML merge and before Zod validation.
 *
 * Supported syntax:
 *   ${VAR}          — substitute process.env.VAR; throw if absent
 *   ${VAR:-default} — substitute process.env.VAR; fall back to "default" if absent
 *
 * Multiple references within a single string are all resolved:
 *   "https://${HOST}:${PORT}/api" is fully expanded.
 *
 * @module @aggregator-dpg/config-loader/interpolate
 */

import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

/** Matches ${VAR} and ${VAR:-default} — captures the inner expression. */
const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

/**
 * Resolves a single placeholder expression against the given env map.
 *
 * @param expr - Inner expression, e.g. "VAR" or "VAR:-fallback".
 * @param env - Environment variable map (defaults to process.env).
 * @returns Resolved string value.
 * @throws {ConfigError} If the variable is missing and no default is provided.
 */
function resolvePlaceholder(expr: string, env: NodeJS.ProcessEnv): string {
  const separatorIdx = expr.indexOf(':-');
  if (separatorIdx !== -1) {
    const varName = expr.slice(0, separatorIdx);
    const defaultValue = expr.slice(separatorIdx + 2);
    return env[varName] ?? defaultValue;
  }

  const value = env[expr];
  if (value === undefined) {
    throw new ConfigError(
      `Environment variable "\${${expr}}" is referenced in config but not set. ` +
        `Set ${expr} or use \${${expr}:-default} to provide a fallback.`,
      { code: 'CONFIG_ENV_VAR_MISSING', details: { variable: expr } },
    );
  }
  return value;
}

/**
 * Interpolates all `${VAR}` / `${VAR:-default}` placeholders in a single string.
 *
 * @param value - String potentially containing placeholders.
 * @param env - Environment variable map.
 * @returns String with all placeholders replaced.
 * @throws {ConfigError} If any placeholder references a missing variable.
 */
function interpolateString(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(PLACEHOLDER_RE, (_match, expr: string) => resolvePlaceholder(expr, env));
}

/**
 * Recursively walks a config value and interpolates all string leaves.
 *
 * Objects and arrays are traversed; non-string scalars are returned unchanged.
 *
 * @param value - Arbitrary config value.
 * @param env - Environment variable map.
 * @returns New value with all string placeholders resolved.
 */
function interpolateValue(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return interpolateString(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, env));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolateValue(v, env);
    }
    return result;
  }
  return value;
}

/**
 * Interpolates all env-var placeholders in a config tree.
 *
 * Call after the YAML merge step and before Zod schema validation.
 *
 * @param config - Merged config tree (mutated by deepMerge output).
 * @param env - Environment variable map; defaults to process.env.
 * @returns New config tree with all placeholders resolved.
 * @throws {ConfigError} With code CONFIG_ENV_VAR_MISSING if any required variable is absent.
 */
export function interpolateConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return interpolateValue(config, env) as Record<string, unknown>;
}
