/**
 * Owner shared-login check (`@aggregator-dpg/api`).
 *
 * An owner who adds themselves as a coordinator keeps one Keycloak user for
 * both accounts. The self-add never writes `aggregator_id` on that user, so a
 * Keycloak user that carries it is a coordinator's own login, even when an
 * admin account is linked to it too (a person registered as both before
 * self-add existed). Only a login with an admin account and no
 * `aggregator_id` counts as shared.
 */

import { getIdpAdmin, KC_ATTR } from '../idp-admin/index.js';

/** The accounts linked to one login, as the identity store lists them. */
export interface LoginAccounts {
  admin: string | null;
  coordinator: string | null;
}

/** Result of {@link isSharedLogin}. */
export type SharedLoginResult =
  { ok: true; value: boolean } | { ok: false; error: { code: string; message: string } };

/**
 * Whether a Keycloak user is an owner's shared login.
 *
 * @param kcUserId - The Keycloak user id.
 * @param accounts - The accounts linked to that user.
 * @returns `true` when an admin account is linked and the user carries no
 *   `aggregator_id`; an error when Keycloak cannot be read. Never throws.
 */
export async function isSharedLogin(
  kcUserId: string,
  accounts: LoginAccounts,
): Promise<SharedLoginResult> {
  if (accounts.admin === null) return { ok: true, value: false };
  const user = await getIdpAdmin().findById(kcUserId);
  if (!user.ok) return { ok: false, error: user.error };
  const pointer = user.value?.attributes?.[KC_ATTR.AGGREGATOR_ID] ?? [];
  return { ok: true, value: pointer.length === 0 };
}
