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
  };
}

/**
 * Combines the caller's cancellation signal with a request deadline.
 *
 * Built by hand rather than with `AbortSignal.any`, which is too recent to
 * assume across the browsers this portal targets.
 *
 * @param signal - The caller's cancel signal, if any.
 * @returns A signal that aborts on either cancellation or timeout.
 */
function withDeadline(signal?: AbortSignal): AbortSignal {
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
  // Clearing on settle keeps a resolved request from holding the timer open.
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
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

export function createPhotonProvider(baseUrl = DEFAULT_PHOTON_URL): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        const url = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(q)}&limit=5`;
        const res = await fetch(url, { signal: withDeadline(signal) });
        if (!res.ok) return [];
        return parsePhotonFeatures(await res.json());
      } catch {
        return [];
      }
    },
  };
}
