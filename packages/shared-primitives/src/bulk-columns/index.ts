/**
 * Well-known bulk-CSV columns that are NOT item-schema properties (#807).
 *
 * The header validator allows only properties of the item schema, and every
 * column is spread verbatim into `item_state`. Anything outside that set fails
 * the whole file. These columns are allowlisted on top, extracted from the row
 * payload BEFORE Ajv runs, and routed to their real destination instead.
 *
 * Extraction has to happen before Ajv because these are not schema properties:
 * a schema with `additionalProperties: false` would otherwise reject every row
 * carrying them, and any that survived would reach Signals as junk
 * `item_state` fields. Extracting once, early, also keeps them out of
 * `item_state` without a second strip step.
 *
 * They are never added to `required` — omitting them is the whole point, since
 * every CSV written before this existed must keep working unchanged.
 */

/**
 * `lat|lng`, pipe-separated.
 *
 * Pipe rather than comma because a comma inside an unquoted CSV cell shifts
 * every subsequent column — a silent mis-import rather than an error. Pipe is
 * also what the network binding already uses for array cells
 * (`csv_array_delimiter: '|'` in every shipped config), so operators have met
 * the convention.
 */
export const GEO_LOCATION_COLUMN = 'geo_location';

/**
 * Operator-facing metadata for a well-known column.
 *
 * These columns carry no JSON Schema, so every schema-driven generator —
 * label, description, allowed-values, example — has nothing to work from and
 * falls back to the raw field name and "Free text". That leaves the one column
 * in the template with a non-obvious format as the only one with no
 * explanation, which defeats the point of putting it in the template at all.
 *
 * Declared here rather than in either template so the CSV and XLSX generators
 * cannot describe the same column differently.
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
    // Spells out the separator because a comma is the natural thing to type
    // and is exactly what the pipe was chosen to avoid: a comma inside an
    // unquoted cell shifts every later column instead of erroring.
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
  /** Column absent or blank — the caller falls back to geocoding the address. */
  | { status: 'absent' }
  | { status: 'ok'; value: ParsedGeoLocation }
  /**
   * Present but unusable. The row still passes and the address is geocoded as
   * before; `reason` is reported to the operator. It deliberately never
   * contains the raw cell — a participant's coordinates are PII.
   */
  | { status: 'invalid'; reason: string };

/**
 * Parses a `geo_location` cell into a point.
 *
 * Unusable input is NOT a row failure. Coordinates are an optimisation — they
 * let Signals skip geocoding — so a malformed cell costs a geocoder call, not
 * correctness, and failing the row would push the operator into a re-upload.
 * That matters because Signals' `onboard` always inserts: a re-upload of a
 * corrected file duplicates every row that already succeeded.
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
  // Empty segments are rejected BEFORE `Number()`, which maps '' to 0 rather
  // than NaN. Without this, `12.9352|` parses as a valid point at longitude 0
  // — a location in the Gulf of Guinea silently stored as the participant's.
  // A half-filled cell must fall back to geocoding, not invent a coordinate.
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
 * Extraction is otherwise unconditional, which would silently rob a schema
 * that legitimately owns one of these names: the value is deleted before Ajv
 * runs, so a `required` property would fail every row with a message naming a
 * column the operator can plainly see in their file. No shipped schema
 * collides today — this keeps it impossible rather than merely unlikely.
 *
 * The schema wins. A network that declares `geo_location` as a real property
 * gets the property, not the well-known column.
 */
export function schemaOwnsColumn(
  schema: Record<string, unknown> | null | undefined,
  name: string,
): boolean {
  const props = schema?.['properties'];
  if (!props || typeof props !== 'object') return false;
  return Object.hasOwn(props as Record<string, unknown>, name);
}
