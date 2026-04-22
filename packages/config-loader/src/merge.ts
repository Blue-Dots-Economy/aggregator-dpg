/**
 * Deep merge utility for config tree assembly.
 *
 * Extracted as a standalone module so it can be tested in isolation and
 * reused by any layer that needs to combine config sources.
 *
 * @module @aggregator-dpg/config-loader/merge
 */

/**
 * Recursively merges source into target. Arrays are replaced, not concatenated.
 * Mutates and returns target.
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
