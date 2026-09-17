/**
 * Selects and memoises the active geo provider.
 *
 * Adapted from Signals-DPG `apps/ui/src/lib/geo/provider.ts`. Same behaviour —
 * Google Places when a maps key is configured, the key-less Photon fallback
 * otherwise, a session cache in front of either, and a central PII-mask guard so
 * form autocomplete never geocodes an API-masked value (e.g. "***",
 * "+91-XX-XXXX-X123").
 *
 * The one difference is where the configuration comes from. Signals reads
 * `import.meta.env` at module scope and caches a single provider; here the
 * values arrive per-request from a React context (see
 * `lib/form-runtime-config.ts` for why they cannot be build-time constants), so
 * the provider is keyed on the configuration it was built from. In practice a
 * process serves one configuration and the map holds one entry; keying it is
 * what keeps the cache honest if that ever stops being true.
 *
 * @module apps/web/lib/geo/provider
 */

import type { GeoProvider } from './types';
import { createPhotonProvider } from './photon';
import { createGooglePlacesProvider } from './google-places';
import { looksLikePIIMask } from './pii-mask';
import { withGeoCache } from './geo-cache';

export interface GeoProviderConfig {
  googleMapsApiKey?: string;
  photonUrl?: string;
}

const cache = new Map<string, GeoProvider>();

/**
 * The active geo provider for a given configuration.
 *
 * Memoised because the underlying providers hold real state worth preserving
 * across widget mounts: the Google provider shares one `<script>` load of the
 * Maps JS API, and `withGeoCache` holds the session's suggestion cache and its
 * in-flight dedup.
 *
 * @param config - Maps key and Photon override, from the form runtime config.
 * @returns A provider whose `suggest` is cached and PII-mask guarded.
 */
export function getGeoProvider(config: GeoProviderConfig): GeoProvider {
  const key = `${config.googleMapsApiKey ?? ''}|${config.photonUrl ?? ''}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const base = withGeoCache(
    config.googleMapsApiKey
      ? createGooglePlacesProvider(config.googleMapsApiKey)
      : createPhotonProvider(config.photonUrl || undefined),
  );
  const provider: GeoProvider = {
    suggest: (query, signal) =>
      looksLikePIIMask(query) ? Promise.resolve([]) : base.suggest(query, signal),
  };
  cache.set(key, provider);
  return provider;
}
