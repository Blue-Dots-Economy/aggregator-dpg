/**
 * Which Keycloak realm roles mark a Signals participant.
 *
 * The coordinator portal and the Signals app share one realm, so a token that
 * fails this portal's `aggregator_id` gate may still be a perfectly valid
 * Signals identity. Recognising that positively is what lets the login screen
 * explain the situation rather than guess (#753).
 *
 * Deployment config, not a constant: the roles Signals stamps are declared on
 * that side (`KEYCLOAK_REQUIRED_REALM_ROLES`), so this reads the same list from
 * the environment and degrades to "unknown account" when unset — a wrong
 * message would be worse than a generic one.
 *
 * @module apps/web/src/lib/signals-roles
 */

/** Env var carrying the comma-separated Signals participant roles. */
const ENV_KEY = 'SIGNALS_REALM_ROLES';

/**
 * Returns the configured Signals participant realm roles.
 *
 * @param env - Env bag; defaults to `process.env`.
 * @returns Role names, or an empty array when unconfigured.
 */
export function signalsRealmRoles(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[ENV_KEY] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}
