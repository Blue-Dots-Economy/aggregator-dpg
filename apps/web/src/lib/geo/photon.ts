/**
 * Key-less geocoding fallback, used when no Google Maps key is configured.
 *
 * Ported from Signals-DPG `apps/ui/src/lib/geo/photon.ts`, with two small
 * adaptations: an `exactOptionalPropertyTypes` fix at the fetch call, and
 * optional chaining in place of two `a && a.b` guards (Sonar S6582).
 *
 * @module apps/web/lib/geo/photon
 */
import type { GeoComponents, GeoProvider, GeoSuggestion } from './types';

const DEFAULT_PHOTON_URL = 'https://photon.komoot.io';

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }; // [lng, lat]
  properties?: {
    name?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    /** ISO 3166-1 alpha-2, e.g. `IN`. */
    countrycode?: string;
    /** Feature granularity, e.g. `city`, `district`, `state`, `country`. */
    type?: string;
  };
}

/** Feature types too coarse to stand in for an address (signals-dpg#788). */
const COARSE_TYPES = new Set(['country', 'state']);

/**
 * Whether a feature is inside `country` and finer than state level.
 *
 * A backstop, not a nicety: an older Photon server ignores the `countrycode`
 * request param and answers worldwide.
 *
 * @param f - A Photon feature.
 * @param country - Upper-case ISO 3166-1 alpha-2 code.
 * @returns True when the feature may be suggested.
 */
function isInCountry(f: PhotonFeature, country: string): boolean {
  const p = f.properties ?? {};
  return p.countrycode?.toUpperCase() === country && !(p.type && COARSE_TYPES.has(p.type));
}

/** Pure: maps a Photon FeatureCollection JSON into suggestions. Exported for testing. */
export function parsePhotonFeatures(json: unknown): GeoSuggestion[] {
  const features = (json as { features?: PhotonFeature[] })?.features ?? [];
  const out: GeoSuggestion[] = [];
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (coords?.length !== 2) continue;
    const [lng, lat] = coords;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const p = f.properties ?? {};
    const label = [p.name, p.city, p.state, p.postcode, p.country]
      .filter((s): s is string => Boolean(s?.trim()))
      .join(', ');
    const components: GeoComponents = {
      locality: p.name,
      city: p.city,
      state: p.state,
      postcode: p.postcode,
      country: p.country,
    };
    out.push({ label: label || `${lat}, ${lng}`, lat, lng, components });
  }
  return out;
}

/**
 * Photon autocomplete provider.
 *
 * `country` (upper-case ISO 3166-1 alpha-2, e.g. `IN`) restricts suggestions to
 * that country (signals-dpg#788): sent as Photon's `countrycode` param and
 * re-checked on every feature, since an older Photon server answers worldwide
 * regardless. Country- and state-level features are dropped too.
 *
 * @param baseUrl - Photon host. Defaults to the public one.
 * @param country - Optional country restriction.
 * @returns The provider.
 */
export function createPhotonProvider(baseUrl = DEFAULT_PHOTON_URL, country?: string): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        const base = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(q)}&limit=5`;
        const url = country ? `${base}&countrycode=${country}` : base;
        // Spread rather than `{ signal }`: under `exactOptionalPropertyTypes`,
        // `RequestInit.signal` is `AbortSignal | null` and will not accept an
        // explicit `undefined` from the optional parameter.
        const res = await fetch(url, { ...(signal ? { signal } : {}) });
        if (!res.ok) return [];
        const json = (await res.json()) as { features?: PhotonFeature[] };
        if (!country) return parsePhotonFeatures(json);
        return parsePhotonFeatures({
          features: (json.features ?? []).filter((f) => isInCountry(f, country)),
        });
      } catch {
        return [];
      }
    },
  };
}
