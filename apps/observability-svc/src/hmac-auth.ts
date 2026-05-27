/**
 * HMAC-SHA256 verification for /emit/* endpoints.
 *
 * Producers sign `(timestamp + body)` with a per-caller secret keyed by
 * `keyId`. The `timestamp` must be within ±5 minutes of the receiver's
 * clock (replay window). All comparisons are constant-time via
 * `timingSafeEqual`.
 *
 * @module hmac-auth
 * @package @aggregator-dpg/observability-svc
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const REPLAY_WINDOW_MS = 5 * 60_000;

/** Result codes returned by {@link verifyHmac}. */
export type HmacResult = 'ok' | 'unknown_key' | 'bad_sig' | 'stale' | 'missing';

/** Arguments passed to {@link verifyHmac}. */
interface VerifyArgs {
  /** Caller-supplied key identifier used to look up the shared secret. */
  keyId: string | undefined;
  /** Hex-encoded HMAC-SHA256 signature of `timestamp + body`. */
  signature: string | undefined;
  /** Unix epoch in milliseconds as a string, supplied by the caller. */
  timestamp: string | undefined;
  /** Raw request body string that was signed. */
  body: string;
  /** Map of keyId → shared secret loaded from config at startup. */
  secrets: Record<string, string>;
  /** Override for the current time in ms (defaults to `Date.now()`). */
  now?: number;
}

/**
 * Verifies an HMAC-SHA256 signature on an inbound event payload.
 *
 * @param args - Verification inputs including keyId, signature, timestamp, body and secrets map.
 * @returns An {@link HmacResult} indicating the outcome:
 *   - `'ok'`          — signature is valid and timestamp is within the replay window.
 *   - `'missing'`     — one or more required fields (keyId, signature, timestamp) are absent.
 *   - `'unknown_key'` — keyId not found in the secrets map.
 *   - `'stale'`       — timestamp is outside the ±5 minute replay window.
 *   - `'bad_sig'`     — signature does not match the expected HMAC.
 */
export function verifyHmac(args: VerifyArgs): HmacResult {
  if (!args.keyId || !args.signature || !args.timestamp) return 'missing';

  const secret = args.secrets[args.keyId];
  if (!secret) return 'unknown_key';

  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return 'stale';

  const now = args.now ?? Date.now();
  if (Math.abs(now - ts) > REPLAY_WINDOW_MS) return 'stale';

  const expected = createHmac('sha256', secret)
    .update(args.timestamp + args.body)
    .digest('hex');

  const a = Buffer.from(args.signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'bad_sig';

  return 'ok';
}
