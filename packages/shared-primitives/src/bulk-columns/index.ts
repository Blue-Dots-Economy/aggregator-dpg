/**
 * Well-known bulk-CSV columns that are not item-schema properties.
 *
 * These columns are allowed in the header on top of the item schema. They are
 * removed from the row payload before Ajv runs and sent to their own
 * destination, so they never reach `item_state`. They are always optional.
 */

/**
 * `lat|lng`, pipe-separated.
 *
 * A pipe is used because a comma in an unquoted CSV cell shifts later columns.
 * It matches the `csv_array_delimiter` used for array cells.
 */
export const GEO_LOCATION_COLUMN = 'geo_location';

/**
 * Operator-facing metadata for a well-known column.
 *
 * These columns have no JSON Schema, so this supplies the label, description
 * and example for the CSV and XLSX templates.
 */
export interface WellKnownColumnMeta {
  /** Human label, standing in for a schema `title`. */
  title: string;
  /** One-line explanation, standing in for a schema `description`. */
  description: string;
  /** Example cell value. */
  example: string;
}

export const WELL_KNOWN_COLUMN_META: Readonly<Record<string, WellKnownColumnMeta>> = {
  [GEO_LOCATION_COLUMN]: {
    title: 'Location coordinates',
    // Names the separator because users tend to type a comma.
    description:
      'Optional. Latitude and longitude separated by a pipe — for example 12.9352|77.6245. ' +
      'Use a pipe, not a comma. Leave blank to have the address looked up instead.',
    example: '12.9352|77.6245',
  },
};

/** Metadata for `name`, or undefined when it is a normal schema property. */
export function wellKnownColumnMeta(name: string): WellKnownColumnMeta | undefined {
  return WELL_KNOWN_COLUMN_META[name];
}

/** Every well-known column, for the header allowlist. */
export const WELL_KNOWN_COLUMNS: readonly string[] = [GEO_LOCATION_COLUMN];

/** A point as Signals' `item_locations` accepts it. */
export interface ParsedGeoLocation {
  lat: number;
  lng: number;
}

export type GeoLocationParse =
  /** Column absent or blank. The caller geocodes the address instead. */
  | { status: 'absent' }
  | { status: 'ok'; value: ParsedGeoLocation }
  /**
   * Present but unusable. The row still passes and the address is geocoded.
   * `reason` never contains the raw cell, because coordinates are PII.
   */
  | { status: 'invalid'; reason: string };

/**
 * Parses a `geo_location` cell into a point.
 *
 * Unusable input does not fail the row; the address is geocoded instead.
 * Failing it would force a re-upload, and Signals `onboard` duplicates rows
 * that already succeeded.
 *
 * @param raw - The cell value.
 * @returns The parsed point, `absent`, or `invalid` with a reason.
 */
export function parseGeoLocation(raw: unknown): GeoLocationParse {
  if (typeof raw !== 'string') return { status: 'absent' };
  const trimmed = raw.trim();
  if (trimmed === '') return { status: 'absent' };

  const parts = trimmed.split('|');
  if (parts.length !== 2) {
    return {
      status: 'invalid',
      reason: `expected two values separated by '|' (lat|lng), found ${parts.length}`,
    };
  }

  const latRaw = parts[0]?.trim() ?? '';
  const lngRaw = parts[1]?.trim() ?? '';
  // Check before `Number()`, which turns '' into 0.
  if (latRaw === '' || lngRaw === '') {
    return { status: 'invalid', reason: 'latitude and longitude must both be present' };
  }

  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: 'invalid', reason: 'latitude and longitude must both be numbers' };
  }
  if (lat < -90 || lat > 90) {
    return { status: 'invalid', reason: 'latitude out of range (-90..90)' };
  }
  if (lng < -180 || lng > 180) {
    return { status: 'invalid', reason: 'longitude out of range (-180..180)' };
  }
  return { status: 'ok', value: { lat, lng } };
}

/**
 * True when the item schema itself declares `name` as a property.
 *
 * When the schema owns the name, the column is treated as a normal schema
 * property and is not extracted.
 *
 * @param schema - The item schema.
 * @param name - The column name.
 * @returns Whether the schema declares `name` in `properties`.
 */
export function schemaOwnsColumn(
  schema: Record<string, unknown> | null | undefined,
  name: string,
): boolean {
  const props = schema?.['properties'];
  if (!props || typeof props !== 'object') return false;
  return Object.hasOwn(props, name);
}

/**
 * The bulk CSV field delimiter, used for every parse of an upload.
 *
 * Set explicitly because auto-detect can pick the array delimiter (`|`) instead.
 */
export const CSV_FIELD_DELIMITER = ',';

/** The columns a bulk CSV header must have and may have. */
export interface BulkHeaderColumns {
  /** Columns that must be present: the schema's `required` names. */
  required: string[];
  /** Columns that may be present: schema properties plus {@link WELL_KNOWN_COLUMNS}. */
  allowed: ReadonlySet<string>;
}

/**
 * The header columns a bulk CSV for `schema` must and may have.
 *
 * Well-known columns are allowed but never required.
 *
 * @param schema - The participant item schema.
 */
export function bulkHeaderColumns(schema: Record<string, unknown>): BulkHeaderColumns {
  const requiredList = schema['required'];
  const required = Array.isArray(requiredList)
    ? requiredList.filter((x): x is string => typeof x === 'string')
    : [];
  const props = schema['properties'];
  const properties = props && typeof props === 'object' ? Object.keys(props) : [];
  return { required, allowed: new Set([...properties, ...WELL_KNOWN_COLUMNS]) };
}

/** A header cell as text: strings as-is, other scalars stringified, anything else `''`. */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'bigint') {
    return String(cell);
  }
  return '';
}

/**
 * The header record's cells as column names: each cell trimmed, a missing cell `''`.
 *
 * @param record - The first non-empty record of the CSV.
 */
export function normaliseHeaderCells(record: readonly unknown[]): string[] {
  return record.map((h) => cellText(h).trim());
}

/** Why a header fails: required columns missing, or columns the schema does not declare. */
export interface BulkHeaderProblem {
  kind: 'missing' | 'unknown';
  columns: string[];
}

/**
 * Checks a header against the columns a schema allows; missing columns are reported first.
 *
 * @param headers - Column names from {@link normaliseHeaderCells}.
 * @param columns - From {@link bulkHeaderColumns}.
 * @returns The problem, or `null` when the header is accepted.
 */
export function checkBulkHeader(
  headers: readonly string[],
  columns: BulkHeaderColumns,
): BulkHeaderProblem | null {
  const present = new Set(headers);
  const missing = columns.required.filter((f) => !present.has(f));
  if (missing.length > 0) return { kind: 'missing', columns: missing };
  const unknown = headers.filter((h) => !columns.allowed.has(h));
  if (unknown.length > 0) return { kind: 'unknown', columns: unknown };
  return null;
}
