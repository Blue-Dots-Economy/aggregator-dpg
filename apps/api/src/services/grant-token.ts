/**
 * Org-owner grant-token mint and verify (#701).
 *
 * The grant is the org owner's key to the invite-mint page — the only surface
 * available to them, since their Keycloak user is deliberately disabled (#699).
 * Mirrors `approval-token.ts` / `invite-token.ts`: HS256 via `jose`, issuer
 * `aggregator-api`, secret reused from `APPROVAL_TOKEN_SECRET`, distinguishing
 * **audience `aggregator-grant`**.
 *
 * Grant and invite lifetimes differ deliberately: invites are 14 days, the
 * grant is 90 days (`GRANT_TOKEN_TTL_SECONDS`). A 14-day grant would strand an
 * owner who cannot log in. An expired-but-signature-valid grant is recoverable
 * (`allowExpired`) — the owner requests a fresh link, emailed to the org's
 * registered owner address (never a request-supplied one).
 */

import { SignJWT, jwtVerify, decodeJwt, errors as joseErrors } from 'jose';

const ALG = 'HS256';
const ISSUER = 'aggregator-api';
const AUDIENCE = 'aggregator-grant';
/** 90 days — overridable via `ttlSec` (`GRANT_TOKEN_TTL_SECONDS`). */
const DEFAULT_TTL_SEC = 90 * 24 * 60 * 60;

let cachedKey: Uint8Array | null = null;

function getKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const raw = process.env.APPROVAL_TOKEN_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('APPROVAL_TOKEN_SECRET must be set and at least 32 chars');
  }
  cachedKey = new TextEncoder().encode(raw);
  return cachedKey;
}

export interface MintGrantInput {
  /** `parent_org_id` the grant admits its holder to invite coordinators for. */
  org: string;
  /** Lifetime in seconds. Default 90 days. */
  ttlSec?: number;
}

export interface MintGrantResult {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a signed owner-grant token bound to an org.
 *
 * @param input - `org` (parent_org_id) and optional TTL.
 * @returns The token string and its absolute expiry timestamp.
 * @throws {Error} If `APPROVAL_TOKEN_SECRET` is unset or too short.
 */
export async function mintGrantToken(input: MintGrantInput): Promise<MintGrantResult> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(input.org)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getKey());
  return { token, expiresAt };
}

export interface VerifyGrantOk {
  ok: true;
  /** `parent_org_id` (token `sub`). */
  org: string;
  /** True when the token was accepted only because `allowExpired` was set. */
  expired: boolean;
}

export interface VerifyGrantErr {
  ok: false;
  error: { code: 'EXPIRED' | 'INVALID' | 'MALFORMED'; message: string };
}

export type VerifyGrantResult = VerifyGrantOk | VerifyGrantErr;

/**
 * Verifies a grant token's signature, audience, issuer, expiry, and `sub`.
 *
 * With `opts.allowExpired`, an expired-but-signature-valid grant is accepted
 * and flagged `expired: true` — used only by the recovery path to recover the
 * org id from a stale link before emailing a fresh grant to the registered
 * owner. Signature/issuer/audience failures still error regardless.
 *
 * @param token - Raw grant JWT from the owner link.
 * @param opts - Set `allowExpired: true` for the recovery path.
 * @returns The `org` (+ `expired` flag) on success; a structured error otherwise.
 */
export async function verifyGrantToken(
  token: string,
  opts: { allowExpired?: boolean } = {},
): Promise<VerifyGrantResult> {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: { code: 'MALFORMED', message: 'token is not a JWT' } };
  }
  try {
    const { payload } = await jwtVerify(token, getKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub claim' } };
    }
    return { ok: true, org: payload.sub, expired: false };
  } catch (err) {
    return mapVerifyError(err, token, opts.allowExpired ?? false);
  }
}

/**
 * Maps a jose verify error to a {@link VerifyGrantResult}, applying the
 * expired-grant recovery path when allowed. Split out of {@link verifyGrantToken}
 * to keep that function's control flow flat.
 *
 * @param err - The thrown jose error.
 * @param token - The original token (for the safe expired-payload decode).
 * @param allowExpired - Whether an expired-but-signed grant is acceptable.
 * @returns The verify result.
 */
function mapVerifyError(err: unknown, token: string, allowExpired: boolean): VerifyGrantResult {
  if (err instanceof joseErrors.JWTExpired) {
    if (!allowExpired) return { ok: false, error: { code: 'EXPIRED', message: 'grant expired' } };
    // jose verifies the signature before `exp`, so a JWTExpired throw proves the
    // signature was genuine — decoding the payload here is safe.
    const payload = decodeJwt(token);
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub in expired grant' } };
    }
    return { ok: true, org: payload.sub, expired: true };
  }
  if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
    return { ok: false, error: { code: 'MALFORMED', message: err.message } };
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return { ok: false, error: { code: 'INVALID', message: 'signature failed' } };
  }
  return {
    ok: false,
    error: { code: 'INVALID', message: err instanceof Error ? err.message : 'verify failed' },
  };
}

/** Test helper — clears the cached key so env changes take effect. */
export function _resetGrantTokenKey(): void {
  cachedKey = null;
}
