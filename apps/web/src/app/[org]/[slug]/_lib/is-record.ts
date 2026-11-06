/**
 * Plain-object guard for the public registration view (web app).
 */

/**
 * Whether a value is a plain object (not `null`, not an array).
 *
 * @param value - Any value, usually parsed JSON or a schema node.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
