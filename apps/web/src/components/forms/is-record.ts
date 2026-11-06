/**
 * Type guard shared by the RJSF theme and the form widgets.
 *
 * RJSF types `formContext`, ui options and child element props loosely, so the
 * form code narrows them with this guard before reading a key.
 *
 * @module apps/web/components/forms/is-record
 */

/**
 * Tells whether a value is a plain object whose keys can be read.
 *
 * @param value - Any value.
 * @returns `true` for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
