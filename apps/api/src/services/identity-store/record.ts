/**
 * Best-effort recording of a coordinator's IdP login (`@aggregator-dpg/api`,
 * migration 0027).
 *
 * The database learns a coordinator's IdP subject lazily: when an approver
 * opens the review link (the subject is resolved there anyway) and on the
 * coordinator's first approved request per process. A failure is logged and
 * never blocks the caller; a conflicting link is never overwritten.
 */

import { logger } from '../../logger.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { getIdentityStore } from './index.js';
import type { IdentityStoreBase } from './interface.js';

/**
 * Users already recorded by this process, per store instance — avoids a write
 * per request (and starts empty whenever a different store is in use).
 */
let recorded = new WeakMap<IdentityStoreBase, Set<string>>();

/**
 * Links the user's login at this deployment's IdP, once per process.
 *
 * @param userId - The account (`users.id`).
 * @param subject - The IdP's user id.
 * @param operation - Caller name for the log entry.
 */
export async function recordLoginIdentity(
  userId: string,
  subject: string,
  operation: string,
): Promise<void> {
  const store = getIdentityStore();
  let seen = recorded.get(store);
  if (!seen) {
    seen = new Set<string>();
    recorded.set(store, seen);
  }
  if (seen.has(userId)) return;
  // Only a coordinator account may be linked through this path (the subject
  // comes from a coordinator's token or review link).
  const r = await store.link(userId, IDP_PROVIDER, subject, 'coordinator');
  if (r.ok) {
    seen.add(userId);
    if (r.value === 'linked') {
      logger.info({ operation, status: 'success', aggregator_id: userId, identity: 'linked' });
    }
    return;
  }
  if (r.error.code !== 'DB_UNAVAILABLE') seen.add(userId); // a conflict will not heal by retrying
  logger.warn({ operation, status: 'failure', error: r.error.code, aggregator_id: userId });
}

/** Test helper — forget which users were recorded. */
export function _resetRecordedIdentities(): void {
  recorded = new WeakMap();
}
