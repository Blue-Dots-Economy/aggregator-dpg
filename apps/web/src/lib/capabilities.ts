/**
 * Capability checks for the portal and the console (`apps/web`).
 *
 * Capabilities come from `GET /v1/user/read/me`. `null` means access control
 * is off, so nothing is hidden. Hiding is for convenience only; the API
 * authorises every request.
 *
 * @module apps/web/src/lib/capabilities
 */

/**
 * Whether the caller may use something that needs `capability`.
 *
 * @param capabilities - The caller's capabilities, or null / undefined when
 *   access control is off.
 * @param capability - The capability the feature needs.
 * @returns True when the feature should be shown.
 */
export function can(
  capabilities: readonly string[] | null | undefined,
  capability: string,
): boolean {
  return capabilities == null || capabilities.includes(capability);
}
