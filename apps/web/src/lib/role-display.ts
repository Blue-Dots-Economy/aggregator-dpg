/**
 * How the console names roles. The base role every team member holds is
 * stored as "Coordinator"; the console shows it by what it lets a team member
 * do. Part of the web console.
 *
 * @module apps/web/src/lib/role-display
 */

/** Key of the base role every team member holds through membership. */
const TEAM_MEMBER_BASE_ROLE = 'coordinator';

/**
 * Returns the roles with the team-member base role renamed for display.
 *
 * @param roles - Roles as the API returns them.
 * @param baseRoleName - The display name of the team-member base role.
 * @returns A copy of the roles; every other role is unchanged.
 */
export function withRoleDisplayNames<T extends { key: string; name: string }>(
  roles: readonly T[],
  baseRoleName: string,
): T[] {
  return roles.map((r) => (r.key === TEAM_MEMBER_BASE_ROLE ? { ...r, name: baseRoleName } : r));
}
