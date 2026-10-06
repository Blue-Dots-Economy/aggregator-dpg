/**
 * Capability metadata that the policy and the config validation share
 * (`@aggregator-dpg/rbac`).
 *
 * @module @aggregator-dpg/rbac/catalogue
 */

import type { Capability } from './interface.js';

/** Listed so the shape is settled, but refused until the feature is built. */
export const NOT_GRANTABLE: readonly Capability[] = ['orgs.block'];

/** Capabilities that may be granted to one user on top of their role. */
export const USER_GRANTABLE: readonly Capability[] = ['profiles.view_pii'];

/** Capabilities that expose or process decrypted personal data; every use is audited. */
export const SENSITIVE: readonly Capability[] = [
  'profiles.view_pii',
  'campaigns.run',
  'contact.unmask',
];
