/**
 * Reads whether the signed-in user still has to accept the current terms (`@aggregator-dpg/web`).
 *
 * Calls `GET /v1/user/consent/status` with the access token. The login
 * callback runs this before the session exists, so it cannot go through `callApi`.
 */

import 'server-only';
import { z } from 'zod';
import { logger } from './logger';

/** Where a user with outstanding terms is sent to accept them. */
export const ACCEPT_TERMS_PATH = '/accept-terms';

/**
 * Upstream timeout for the status call.
 *
 * Short on purpose: it sits on the sign-in path, and a slow or down API
 * must not hold the login. On timeout the status is `unknown` and the user
 * gets in; the API still refuses gated calls until the terms are accepted.
 */
export const TERMS_STATUS_TIMEOUT_MS = 5_000;

/** `ok`: current terms accepted. `outstanding`: must accept. `unknown`: the check failed. */
export type TermsStatus = 'ok' | 'outstanding' | 'unknown';

/** The result of the terms check. The audience and versions are present when the check succeeded. */
export interface TermsCheck {
  status: TermsStatus;
  audience?: 'aggregator' | 'org';
  termsVersion?: number;
  privacyVersion?: number;
}

/** Body of `GET /v1/user/consent/status`. */
const ConsentStatusSchema = z.object({
  outstanding: z.boolean(),
  audience: z.enum(['aggregator', 'org']),
  terms_version: z.number(),
  privacy_version: z.number(),
  org_ids: z.array(z.string()),
});

/**
 * Reads the caller's terms status. Never throws.
 *
 * @param accessToken - The caller's access token.
 * @param log - Request logger.
 * @returns The status; `unknown` on any error, non-200 answer or unexpected body.
 */
export async function fetchTermsStatus(
  accessToken: string,
  log: typeof logger = logger,
): Promise<TermsCheck> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const start = Date.now();
  try {
    const res = await fetch(`${base}/v1/user/consent/status`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TERMS_STATUS_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      log.warn({
        operation: 'terms.status',
        status: 'failure',
        code: `HTTP_${res.status}`,
        latency_ms: Date.now() - start,
      });
      return { status: 'unknown' };
    }
    const parsed = ConsentStatusSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      log.warn({
        operation: 'terms.status',
        status: 'failure',
        code: 'RESPONSE_SHAPE_INVALID',
        latency_ms: Date.now() - start,
      });
      return { status: 'unknown' };
    }
    const body = parsed.data;
    log.info({
      operation: 'terms.status',
      status: 'success',
      outstanding: body.outstanding,
      latency_ms: Date.now() - start,
    });
    return {
      status: body.outstanding ? 'outstanding' : 'ok',
      audience: body.audience,
      termsVersion: body.terms_version,
      privacyVersion: body.privacy_version,
    };
  } catch (err) {
    log.warn({
      operation: 'terms.status',
      status: 'failure',
      error: err instanceof Error ? err.name : 'UnknownError',
      latency_ms: Date.now() - start,
    });
    return { status: 'unknown' };
  }
}
