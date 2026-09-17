/**
 * Shared shapes for address autocomplete.
 *
 * Ported from Signals-DPG `apps/ui/src/lib/geo/types.ts`. The public
 * registration form and the Signals profile form render the same network.json
 * schemas, so a `location`-marked field must behave identically in both; keeping
 * these files comparable is what makes that checkable.
 *
 * One deliberate difference: `GeoComponents`' members are `?: string | undefined`
 * rather than a bare `?: string`. This app compiles with
 * `exactOptionalPropertyTypes` and Signals does not; under it, a bare optional
 * rejects an explicitly-assigned `undefined`, so both providers — which build
 * this object in a single literal from lookups that may miss — would not
 * compile. Widening here confines the adaptation to one file instead of
 * restructuring each provider away from its Signals original.
 *
 * @module apps/web/lib/geo/types
 */
export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeoComponents {
  locality?: string | undefined; // area / sublocality / neighbourhood
  city?: string | undefined;
  state?: string | undefined;
  postcode?: string | undefined;
  country?: string | undefined;
}

export interface GeoSuggestion extends LatLng {
  /** Human-readable label shown in the dropdown. */
  label: string;
  components?: GeoComponents;
}

export interface GeoProvider {
  /** Returns ranked suggestions for a free-text query (empty array on error). */
  suggest(query: string, signal?: AbortSignal): Promise<GeoSuggestion[]>;
}
