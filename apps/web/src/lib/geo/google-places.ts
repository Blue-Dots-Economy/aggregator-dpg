/**
 * Google Places (New) autocomplete provider.
 *
 * Loads the Maps JS API on first use via a single shared <script> tag, then
 * resolves each prediction to its coordinate + address components.
 *
 * Ported from Signals-DPG `apps/ui/src/lib/geo/google-places.ts`, with the
 * address-component mapping lifted out of the prediction loop into
 * `toGeoComponents` — see the note there.
 *
 * @module apps/web/lib/geo/google-places
 */
import type { GeoComponents, GeoProvider, GeoSuggestion } from './types';

type GoogleNS = {
  maps: {
    importLibrary: (name: string) => Promise<Record<string, unknown>>;
  };
};

let scriptPromise: Promise<void> | null = null;

function loadMapsApi(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as unknown as { google?: GoogleNS }).google?.maps?.importLibrary) {
    return Promise.resolve();
  }
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-dpg-google-maps="true"]',
    );
    (window as unknown as { __dpgGoogleMapsInit?: () => void }).__dpgGoogleMapsInit = () =>
      resolve();
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('maps load failed')), {
        once: true,
      });
      return;
    }
    const script = document.createElement('script');
    const url = new URL('https://maps.googleapis.com/maps/api/js');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('libraries', 'places');
    url.searchParams.set('callback', '__dpgGoogleMapsInit');
    url.searchParams.set('loading', 'async');
    url.searchParams.set('v', 'weekly');
    script.src = url.toString();
    script.async = true;
    script.defer = true;
    script.dataset.dpgGoogleMaps = 'true';
    script.onerror = () => reject(new Error('maps load failed'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

type AddressComponent = { types: string[]; longText: string; shortText: string };

/**
 * Maps Google's flat address-component list onto our `GeoComponents` shape.
 *
 * Extracted from the prediction loop it is called from, where it sat as a
 * closure inside a closure inside a `.map()` — six levels of nesting, which
 * Sonar flags (S2004) and which made the component-priority rules below hard to
 * see. Priority matters: Google returns several components that could each be
 * called "the locality", and picking the wrong one puts a neighbourhood label
 * where a city belongs.
 *
 * @param components - `addressComponents` from a resolved Place.
 * @returns The mapped components; any field Google did not supply is absent.
 */
function toGeoComponents(components: AddressComponent[]): GeoComponents {
  const find = (types: string[]): string | undefined =>
    components.find((c) => types.some((t) => c.types.includes(t)))?.longText;

  return {
    locality: find(['sublocality', 'sublocality_level_1', 'neighborhood']) ?? find(['locality']),
    city: find(['locality']) ?? find(['administrative_area_level_2']),
    state: find(['administrative_area_level_1']),
    postcode: find(['postal_code']),
    country: find(['country']),
  };
}

export function createGooglePlacesProvider(apiKey: string): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        await loadMapsApi(apiKey);
        const places = (await (window as unknown as { google: GoogleNS }).google.maps.importLibrary(
          'places',
        )) as {
          AutocompleteSessionToken: new () => object;
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: (req: object) => Promise<{
              suggestions: Array<{
                placePrediction: {
                  text: { toString: () => string };
                  toPlace: () => {
                    fetchFields: (req: { fields: string[] }) => Promise<void>;
                    location?: { lat: () => number; lng: () => number };
                    addressComponents?: Array<{
                      types: string[];
                      longText: string;
                      shortText: string;
                    }>;
                  };
                };
              }>;
            }>;
          };
        };

        const token = new places.AutocompleteSessionToken();
        const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q,
          sessionToken: token,
        });

        const top = suggestions.slice(0, 5);
        const resolved: (GeoSuggestion | null)[] = await Promise.all(
          top.map(async (s): Promise<GeoSuggestion | null> => {
            if (signal?.aborted) return null;
            const place = s.placePrediction.toPlace();
            await place.fetchFields({ fields: ['location', 'addressComponents'] });
            const loc = place.location;
            if (!loc) return null;
            return {
              label: s.placePrediction.text.toString(),
              lat: loc.lat(),
              lng: loc.lng(),
              components: toGeoComponents(place.addressComponents ?? []),
            };
          }),
        );
        return resolved.filter((x): x is GeoSuggestion => x !== null);
      } catch {
        return [];
      }
    },
  };
}
