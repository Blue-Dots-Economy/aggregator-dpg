/**
 * List key for an address suggestion, shared by the location widgets
 * (web app, `apps/web`).
 *
 * @module apps/web/components/forms/custom-widgets/geo-suggestion-key
 */
import type { GeoSuggestion } from '@/lib/geo/types';

/**
 * Identifies a suggestion by its point and label, which geocoders return the
 * same way for the same place on every search.
 *
 * @param suggestion - One geocoder result.
 * @returns The base key to pass to `withStableKeys`.
 */
export function geoSuggestionKey(suggestion: GeoSuggestion): string {
  return `${suggestion.lat},${suggestion.lng},${suggestion.label}`;
}
