/**
 * Optional coordinate passthrough for bulk CSV rows.
 *
 * Signals' `POST /admin/participant` accepts an optional `item_locations`
 * array. When it is present and non-empty signals stores those coordinates
 * as-is and does NOT geocode the address text in `item_state`; when it is
 * absent signals geocodes as it always has. An operator who already holds
 * exact coordinates can therefore skip server-side geocoding entirely — which
 * matters on a Photon-backed deployment, where geocoding is rate-limited to
 * roughly one request per second and a large upload would otherwise crawl or
 * time out.
 *
 * These three columns are NOT schema properties, so {@link extractBulkItemLocations}
 * removes them from the row payload **before** Ajv runs: a schema declaring
 * `additionalProperties: false` would otherwise fail every row carrying them.
 * Removing them there also keeps them out of `item_state`, so they never leak
 * upstream as junk profile fields.
 *
 * Deliberately forgiving: unusable coordinates are ignored, never fatal. A row
 * with a half-filled or malformed pair still onboards and falls back to
 * server-side geocoding, exactly as a row with no coordinate columns does.
 * The caller logs the `ignored` reason so a broken generator stays visible
 * without failing anybody's upload.
 *
 * @module apps/worker/jobs/bulk-location-columns
 */

/** CSV column carrying the latitude, in decimal degrees. */
export const LATITUDE_COLUMN = 'latitude';
/** CSV column carrying the longitude, in decimal degrees. */
export const LONGITUDE_COLUMN = 'longitude';
/** Optional CSV column naming the point (e.g. `Head Office`). */
export const LOCATION_LABEL_COLUMN = 'location_label';

/**
 * Every column this module owns. Added to the header validator's `allowed`
 * set so the file-level check does not reject them as `unknown`, and deleted
 * from the payload by {@link extractBulkItemLocations}.
 */
export const BULK_LOCATION_COLUMNS = [
  LATITUDE_COLUMN,
  LONGITUDE_COLUMN,
  LOCATION_LABEL_COLUMN,
] as const;

/** One coordinate forwarded to signals as `item_locations[0]`. */
export interface BulkItemLocation {
  lat: number;
  lng: number;
  label?: string;
}

/** Why a supplied coordinate pair could not be used. */
export interface IgnoredBulkLocation {
  latitude: string;
  longitude: string;
  reason: string;
}

export interface BulkLocationExtract {
  /** Non-empty when a usable pair was found; `null` otherwise. */
  locations: BulkItemLocation[] | null;
  /**
   * Set when the row supplied *something* that could not be used. `null` both
   * when the columns were absent and when they were present but empty — an
   * empty cell is "no coordinate", not an error.
   */
  ignored: IgnoredBulkLocation | null;
}

/** Reads a CSV cell as a trimmed string. Absent / non-scalar cells read empty. */
function cell(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Parses one coordinate cell.
 *
 * `Number('')` is `0`, so callers must reject empty cells before calling this —
 * otherwise a blank latitude would silently resolve to the equator.
 */
function parseCoordinate(raw: string, limit: number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < -limit || n > limit) return null;
  return n;
}

/**
 * Pulls the coordinate columns out of a bulk row payload.
 *
 * **Mutates `payload`**, deleting every column in {@link BULK_LOCATION_COLUMNS}
 * whether or not a usable coordinate was found. That is the point of the
 * function: the columns must not reach Ajv or `item_state`.
 *
 * @param payload - One parsed CSV row. Mutated in place.
 * @returns The resolved coordinate, or the reason a supplied one was unusable.
 */
export function extractBulkItemLocations(payload: Record<string, unknown>): BulkLocationExtract {
  const latitude = cell(payload[LATITUDE_COLUMN]);
  const longitude = cell(payload[LONGITUDE_COLUMN]);
  const label = cell(payload[LOCATION_LABEL_COLUMN]);

  for (const column of BULK_LOCATION_COLUMNS) {
    delete payload[column];
  }

  // Neither cell filled in — the row simply carries no coordinate. Not an
  // error, and not worth logging: this is every pre-existing CSV.
  if (latitude === '' && longitude === '') {
    return { locations: null, ignored: null };
  }

  const ignore = (reason: string): BulkLocationExtract => ({
    locations: null,
    ignored: { latitude, longitude, reason },
  });

  if (latitude === '') return ignore('latitude is empty but longitude is set');
  if (longitude === '') return ignore('longitude is empty but latitude is set');

  const lat = parseCoordinate(latitude, 90);
  if (lat === null) return ignore('latitude is not a number between -90 and 90');

  const lng = parseCoordinate(longitude, 180);
  if (lng === null) return ignore('longitude is not a number between -180 and 180');

  return {
    locations: [label ? { lat, lng, label } : { lat, lng }],
    ignored: null,
  };
}
