/**
 * Deep merge utility for config tree assembly.
 *
 * Extracted as a standalone module so it can be tested in isolation and
 * reused by any layer that needs to combine config sources.
 *
 * @module @aggregator-dpg/config-loader/merge
 */

/**
 * Keys that reach Object.prototype if assigned through bracket notation.
 *
 * `Object.keys` does not surface `__proto__` on an object literal, but it DOES
 * on anything built by `JSON.parse` or a YAML loader, where it is an own
 * enumerable property. Config here is assembled from fetched documents, so the
 * source side is not guaranteed to be a literal.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively merges source into target. Arrays are replaced, not concatenated.
 * Mutates and returns target.
 *
 * Keys that would reach `Object.prototype` are skipped rather than copied
 * (CodeQL js/prototype-pollution-utility).
 *
 * @param target - Object to merge into (mutated in place).
 * @param source - Object providing override values.
 * @returns The mutated target.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const src = source[key];
    const tgt = target[key];
    if (
      src !== null &&
      typeof src === 'object' &&
      !Array.isArray(src) &&
      tgt !== null &&
      typeof tgt === 'object' &&
      !Array.isArray(tgt)
    ) {
      deepMerge(tgt as Record<string, unknown>, src as Record<string, unknown>);
    } else {
      target[key] = src;
    }
  }
  return target;
}
