/**
 * Type guards for parsed JSON (`@aggregator-dpg/api`).
 *
 * JSON Schema files and other parsed JSON arrive as `unknown`; these guards
 * narrow them before keys are read.
 *
 * @module apps/api/src/services/json-record
 */

/** A JSON object. */
export type JsonRecord = Record<string, unknown>;

/**
 * Whether `value` is a JSON object (not `null`, not an array).
 *
 * @param value - Any parsed value.
 */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The string entries of `value`, or an empty list when it is not an array.
 *
 * @param value - Any parsed value, such as a schema's `required` list.
 */
export function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
