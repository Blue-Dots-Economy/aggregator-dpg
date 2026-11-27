/**
 * Type guards for parsed config values.
 *
 * Internal module, not a subpath export. Parsed YAML and JSON arrive as
 * `unknown`; these guards narrow them before the loaders read keys.
 *
 * @module @aggregator-dpg/config-loader
 */

/**
 * True for any non-null object, arrays included, so its keys can be read.
 *
 * @param value - Any parsed value.
 */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * True for a non-null, non-array object: a YAML mapping or a JSON object.
 *
 * @param value - Any parsed value.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectLike(value) && !Array.isArray(value);
}
