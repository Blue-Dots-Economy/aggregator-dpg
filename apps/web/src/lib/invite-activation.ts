/**
 * Activates an invited account right after its first sign-in (`@aggregator-dpg/web`).
 *
 * Calls `POST /v1/user/activate` with the new access token; the session does
 * not exist yet, so this cannot go through `callApi`.
 */

import type { logger } from './logger';

/** Upstream timeout for the activation call. */
const ACTIVATE_TIMEOUT_MS = 15_000;

/** Reads `error.code` from an API error envelope. */
function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const e = body.error;
  if (typeof e !== 'object' || e === null || !('code' in e)) return null;
  return typeof e.code === 'string' ? e.code : null;
}

/** The result the OIDC callback acts on. */
export type InviteActivation = 'active' | 'email_not_verified' | 'failed';

/**
 * Activates the caller's invited account.
 *
 * @param accessToken - The access token from the code exchange.
 * @param log - Request logger.
 * @returns `active` on success or when already active; `email_not_verified` when the sign-in did not use the email code.
 */
export async function activateInvitee(
  accessToken: string,
  log: typeof logger,
): Promise<InviteActivation> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const start = Date.now();
  try {
    const res = await fetch(`${base}/v1/user/activate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(ACTIVATE_TIMEOUT_MS),
    });
    if (res.ok) {
      log.info({ operation: 'invite.activate', status: 'success', latency_ms: Date.now() - start });
      return 'active';
    }
    const code = errorCode(await res.json().catch(() => null)) ?? `HTTP_${res.status}`;
    log.warn({
      operation: 'invite.activate',
      status: 'failure',
      code,
      latency_ms: Date.now() - start,
    });
    return code === 'EMAIL_NOT_VERIFIED' ? 'email_not_verified' : 'failed';
  } catch (err) {
    log.error({
      operation: 'invite.activate',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return 'failed';
  }
}
