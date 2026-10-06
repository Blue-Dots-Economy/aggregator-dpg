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

/**
 * Deadline for a single geocoder call.
 *
 * `.claude/rules/error-handling.md` requires an explicit timeout on every
 * external call. The caller's `signal` is a *cancellation* channel — it aborts
 * when the next keystroke supersedes this query — not a deadline, so a public
 * endpoint that accepts the connection and then stalls would leave the request
 * hanging and the dropdown empty with no explanation.
 *
 * 4s: long enough for a cold lookup over a slow mobile link, short enough that
 * a stalled request gives up before the person has retyped the line.
 */
const REQUEST_TIMEOUT_MS = 4_000;

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

/**
 * Combines the caller's cancellation signal with a request deadline.
 *
 * Built by hand rather than with `AbortSignal.any`, which is too recent to
 * assume across the browsers this portal targets.
 *
 * @param signal - The caller's cancel signal, if any.
 * @returns The combined signal, and `clear` — call it once the request settles
 *   so a finished request does not stay armed and abort 4s later.
 */
function withDeadline(signal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const cancel = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
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
      const deadline = withDeadline(signal);
      try {
        const base = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(q)}&limit=5`;
        const url = country ? `${base}&countrycode=${country}` : base;
        const res = await fetch(url, { signal: deadline.signal });
        if (!res.ok) return [];
        const json = (await res.json()) as { features?: PhotonFeature[] };
        if (!country) return parsePhotonFeatures(json);
        return parsePhotonFeatures({
          features: (json.features ?? []).filter((f) => isInCountry(f, country)),
        });
      } catch {
        return [];
      } finally {
        deadline.clear();
      }
    },
  };
}
