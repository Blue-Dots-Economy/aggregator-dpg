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

/** Users already recorded by this process — avoids a write per request. */
const recorded = new Set<string>();

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
  if (recorded.has(userId)) return;
  const r = await getIdentityStore().link(userId, IDP_PROVIDER, subject);
  if (r.ok) {
    recorded.add(userId);
    if (r.value === 'linked') {
      logger.info({ operation, status: 'success', aggregator_id: userId, identity: 'linked' });
    }
    return;
  }
  if (r.error.code !== 'DB_UNAVAILABLE') recorded.add(userId); // a conflict will not heal by retrying
  logger.warn({ operation, status: 'failure', error: r.error.code, aggregator_id: userId });
}

/** Test helper — forget which users were recorded. */
export function _resetRecordedIdentities(): void {
  recorded.clear();
}
