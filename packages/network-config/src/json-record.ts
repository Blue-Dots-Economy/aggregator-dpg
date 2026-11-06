/**
 * Plain JSON object type and guard shared inside the network-config package.
 *
 * Internal; not a package export. Dependency-free, because `./uri-fields` and
 * `./field-errors` import it and the web app bundles those for the browser.
 *
 * @module @aggregator-dpg/network-config/json-record
 */

/** A parsed JSON object. */
export type JsonRecord = Record<string, unknown>;

/**
 * Returns whether a value is a plain JSON object (not null, not an array).
 *
 * @param value - Any parsed JSON value.
 */
export function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
