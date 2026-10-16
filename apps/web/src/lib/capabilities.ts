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

/** The parts of `read/me` {@link canManageOrg} reads. */
interface ManageScopeSource {
  capabilities?: readonly string[] | null | undefined;
  orgs: ReadonlyArray<{
    id: string;
    org_type: string;
    is_default?: boolean | undefined;
    capabilities?: readonly string[] | null | undefined;
  }>;
}

/**
 * Whether the caller may manage an organisation's coordinators (invite,
 * decide, edit): `org.manage` in that organisation, or in the root, which
 * applies to every organisation (#873). Mirrors the API's manage scope.
 *
 * @param me - The caller's `read/me` answer.
 * @param orgId - The organisation.
 * @returns True when the organisation should be offered.
 */
export function canManageOrg(me: ManageScopeSource, orgId: string): boolean {
  if (me.capabilities == null) return true;
  const holds = (o: ManageScopeSource['orgs'][number] | undefined) =>
    o?.capabilities?.includes('org.manage') ?? false;
  if (holds(me.orgs.find((o) => o.org_type === 'network_facilitator'))) return true;
  return holds(me.orgs.find((o) => o.id === orgId));
}

/**
 * Whether the caller can invite coordinators anywhere: it manages an
 * organisation that takes invites (never the Default org), or holds
 * `org.manage` in the root (#873).
 *
 * @param me - The caller's `read/me` answer.
 * @returns True when the console should offer inviting.
 */
export function canInvite(me: ManageScopeSource): boolean {
  if (me.capabilities == null) return true;
  return me.orgs.some(
    (o) =>
      (o.org_type === 'network_facilitator' || (o.org_type === 'aggregator' && !o.is_default)) &&
      (o.capabilities?.includes('org.manage') ?? false),
  );
}

/**
 * Whether the caller can see coordinators: an organisation's admin
 * (`org.manage`), or the network admin, read-only (`network.administer`)
 * (#873).
 *
 * @param me - The caller's `read/me` answer.
 * @returns True when the console should list coordinators.
 */
export function canViewCoordinators(me: ManageScopeSource): boolean {
  return can(me.capabilities, 'org.manage') || can(me.capabilities, 'network.administer');
}
