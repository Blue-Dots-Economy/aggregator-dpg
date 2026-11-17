/**
 * Whether the console shows an organisation's "known as" value and the
 * hierarchy settings that define those values. Off by default while the
 * feature is reviewed; the API and the stored values are unchanged either way.
 *
 * @module apps/web/src/lib/known-as-flag
 */

/**
 * Reads `ORG_KNOWN_AS_ENABLED`. Only `true` turns the feature on.
 *
 * Call it on the server at request time, so a restart applies a new value, and
 * pass the result down to client components as a prop.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns `true` when "known as" and the hierarchy settings are shown.
 */
export function isKnownAsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.ORG_KNOWN_AS_ENABLED?.trim().toLowerCase() === 'true';
}
