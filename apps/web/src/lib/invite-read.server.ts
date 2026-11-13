/**
 * Reads an invite for its registration page, on the server (`@aggregator-dpg/web`).
 *
 * The invitee has no session, so this uses the service-account token, as the
 * anonymous registration routes do.
 */

import {
  InviteReadResponseSchema,
  type InviteReadResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getServiceAccessToken } from './service-token';
import { logger } from './logger';

/** Upstream timeout for the invite read. */
const READ_TIMEOUT_MS = 10_000;

/** Why an invite page cannot show the form. */
export type InviteReadFailure = 'invalid' | 'expired' | 'used' | 'unavailable' | 'org_inactive';

/** The invite, or why it cannot be used. */
export type InviteReadResult =
  { ok: true; invite: InviteReadResponse } | { ok: false; reason: InviteReadFailure };

const FAILURE_BY_CODE: Readonly<Record<string, InviteReadFailure>> = {
  INVITE_INVALID: 'invalid',
  INVITE_EXPIRED: 'expired',
  INVITE_ALREADY_USED: 'used',
  TARGET_ORG_INACTIVE: 'org_inactive',
};

/** Reads `error.code` from an API error envelope. */
function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const e = body.error;
  if (typeof e !== 'object' || e === null || !('code' in e)) return null;
  return typeof e.code === 'string' ? e.code : null;
}

/**
 * Reads a coordinator or org invite without using it up.
 *
 * @param kind - `user` for a coordinator invite, `org` for an organisation invite.
 * @param token - The invite token from the link.
 * @returns The invited email and org, or a failure reason for the page.
 */
export async function readInvite(kind: 'user' | 'org', token: string): Promise<InviteReadResult> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const log = logger.child({ operation: 'invite.read', kind });
  try {
    const serviceToken = await getServiceAccessToken();
    const res = await fetch(`${base}/v1/${kind}/invite/read?token=${encodeURIComponent(token)}`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const parsed = InviteReadResponseSchema.safeParse(body);
      if (parsed.success) return { ok: true, invite: parsed.data };
      log.error({ status: 'failure', code: 'BAD_RESPONSE' });
      return { ok: false, reason: 'unavailable' };
    }
    const code = errorCode(body);
    const reason = code ? FAILURE_BY_CODE[code] : undefined;
    if (!reason) log.warn({ status: 'failure', code: code ?? `HTTP_${res.status}` });
    return { ok: false, reason: reason ?? (res.status === 400 ? 'invalid' : 'unavailable') };
  } catch (err) {
    log.error({ status: 'failure', error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: 'unavailable' };
  }
}
