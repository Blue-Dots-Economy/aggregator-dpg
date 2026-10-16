/**
 * Capability checks for the portal and the console (`apps/web`, RBAC R2).
 *
 * The capabilities come from `GET /v1/user/read/me`. `null` means access
 * control is off for the instance, so nothing is hidden. Hiding is a
 * convenience only: the API decides every request.
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
