/**
 * Name helpers shared across registration flows. Belongs to `@aggregator-dpg/api`.
 *
 * @module apps/api/src/services/name
 */

/**
 * Splits a single-line contact name into Keycloak's first / last fields.
 * Everything before the first whitespace is the first name; the remainder is
 * the last name. Single-token inputs produce an empty last name; blank input
 * produces two empty strings.
 *
 * @param fullName - The contact's full name from the registration payload.
 * @returns First and last name parts.
 */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const firstSpace = trimmed.search(/\s+/);
  if (firstSpace === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.slice(0, firstSpace),
    lastName: trimmed.slice(firstSpace).trim(),
  };
}
