/**
 * Tiny env-var readers for numeric runtime tuning knobs (timeouts, leads).
 * Part of the web (portal BFF) app; keeps per-deploy values out of module
 * constants per the configuration-discipline rule (#512).
 */

/**
 * Reads a positive-integer env var, falling back when unset or invalid.
 *
 * @param name - Environment variable name.
 * @param fallback - Value used when the var is unset, blank, or not a positive integer.
 * @returns The parsed value or the fallback.
 */
export function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
