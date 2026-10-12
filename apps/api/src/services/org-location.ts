/**
 * Org-detail mapping for org registration (`@aggregator-dpg/api`, migration
 * 0028).
 *
 * The org form's `website`, `address` (+ legacy `state`) and picked
 * `coordinates` become the org's `url` and one Beckn location — the same rule
 * migration 0028 (step O9) applied to existing orgs, so old and new orgs carry
 * the same shape. `addressDistrict` has no Beckn key; it stays in the org's
 * `profile` only.
 */

import type { BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';

/** The org form's address block (all optional). */
export interface OrgFormAddress {
  streetAddress?: string | undefined;
  addressLocality?: string | undefined;
  addressDistrict?: string | undefined;
  addressRegion?: string | undefined;
  postalCode?: string | undefined;
  addressCountry?: string | undefined;
}

/** A trimmed, non-empty string, or `undefined`. */
function nz(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * The org's `url` from its form's website.
 *
 * @param website - Submitted website, if any.
 * @returns The url, or `null`.
 */
export function orgUrlFrom(website: string | null | undefined): string | null {
  return nz(website) ?? null;
}

/**
 * The org's `locations` from its form's address, state and picked point. A
 * location is built only when there is a street or locality, or real
 * coordinates; a state alone gives `[]` (a stub would hide every member's
 * precise address behind it).
 *
 * @param address - The form's address block.
 * @param state - The legacy standalone state field.
 * @param coordinates - `[lng, lat]` picked from the address autocomplete.
 * @returns Zero or one Beckn location.
 */
export function orgLocationsFrom(
  address: OrgFormAddress | null | undefined,
  state: string | null | undefined,
  coordinates: readonly [number, number] | null | undefined,
): BecknLocation[] {
  const street = nz(address?.streetAddress);
  const locality = nz(address?.addressLocality);
  const realPoint =
    Array.isArray(coordinates) &&
    coordinates.length === 2 &&
    (coordinates[0] !== 0 || coordinates[1] !== 0);
  if (!street && !locality && !realPoint) return [];
  const region = nz(address?.addressRegion) ?? nz(state);
  const postalCode = nz(address?.postalCode);
  const country = nz(address?.addressCountry);
  return [
    {
      geo: { type: 'Point', coordinates: realPoint ? [coordinates[0], coordinates[1]] : [0, 0] },
      address: {
        ...(street ? { streetAddress: street } : {}),
        ...(locality ? { addressLocality: locality } : {}),
        ...(region ? { addressRegion: region } : {}),
        ...(postalCode ? { postalCode } : {}),
        ...(country ? { addressCountry: country } : {}),
      },
    },
  ];
}
