/**
 * Server-side read of the invites nobody has used yet, for the console lists (`@aggregator-dpg/web`).
 */

import 'server-only';
import {
  InviteSearchResponseSchema,
  type InviteSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { callApi } from './upstream-client';
import { logger } from './logger';

/** Invites shown per list, the API's page maximum. */
const OPEN_INVITES_LIMIT = 100;

/**
 * Reads the newest unused invites of an organisation.
 *
 * @param kind - `user` for coordinator invites, `org` for organisation invites.
 * @param orgId - The organisation the invites were sent from.
 * @returns The page, or `null` when it cannot be read, so the list is left out.
 */
export async function readOpenInvites(
  kind: 'user' | 'org',
  orgId: string,
): Promise<InviteSearchResponse | null> {
  const body =
    kind === 'user'
      ? { org_id: orgId, limit: OPEN_INVITES_LIMIT }
      : { parent_id: orgId, limit: OPEN_INVITES_LIMIT };
  try {
    const res = await callApi(`/v1/${kind}/invite/search`, { method: 'POST', body });
    if (!res.ok) {
      logger.warn({ operation: 'console.openInvites', status: 'failure', code: res.status });
      return null;
    }
    const parsed = InviteSearchResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch (err) {
    logger.warn({
      operation: 'console.openInvites',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
