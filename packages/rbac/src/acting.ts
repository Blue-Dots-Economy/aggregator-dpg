/**
 * Acting role entries: how an owner who acts as their own coordinator account
 * is named in the access token's `roles` claim (`acting:<accountId>:<roleKey>`).
 * Kept apart from plain role keys so the edge can tell the two apart.
 */

/** Prefix of an acting role entry. */
export const ACTING_ROLE_PREFIX = 'acting:';

/**
 * Builds the acting entry for a role held through another account.
 *
 * @param accountId - The account acted as.
 * @param roleKey - The role key.
 * @returns `acting:<accountId>:<roleKey>`.
 */
export function actingRoleEntry(accountId: string, roleKey: string): string {
  return `${ACTING_ROLE_PREFIX}${accountId}:${roleKey}`;
}

/**
 * Reads an acting entry back.
 *
 * @param entry - A `roles` claim entry.
 * @returns The account and role, or null when the entry is not an acting entry.
 */
export function parseActingRoleEntry(entry: string): { accountId: string; roleKey: string } | null {
  if (!entry.startsWith(ACTING_ROLE_PREFIX)) return null;
  const rest = entry.slice(ACTING_ROLE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { accountId: rest.slice(0, sep), roleKey: rest.slice(sep + 1) };
}
