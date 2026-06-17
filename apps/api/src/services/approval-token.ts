/**
 * Approval-token mint and verify.
 *
 * Each registration submission produces a signed JWT carrying the
 * `aggregator_id` (sub) and an `intent` claim. The token is delivered to the
 * admin via email link; the API verifies the signature and required claims.
 *
 * Single-use is enforced at the application layer by re-checking the
 * Keycloak user state (`enabled` flag) before applying a decision: an
 * already-enabled user yields an "already decided" page instead of
 * re-triggering the action. No DB hash storage required.
 *
 * HS256 with a ≥32-byte secret is sufficient — the issuer and verifier are
 * the same service.
 */

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

const ALG = 'HS256';
const ISSUER = 'aggregator-api';
const AUDIENCE = 'aggregator-admin';
const DEFAULT_TTL_SEC = 60 * 60; // 1 hour

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

export interface MintInput {
  aggregatorId: string;
  intent: 'approve' | 'reject';
  /** Lifetime in seconds. Default 1h. */
  ttlSec?: number;
}

export interface MintResult {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a signed approval token bound to an aggregator + intent.
 *
 * @param input - Aggregator id, intent, optional TTL.
 * @returns Token string and absolute expiry timestamp.
 */
export async function mintApprovalToken(input: MintInput): Promise<MintResult> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({ intent: input.intent })
    .setProtectedHeader({ alg: ALG })
    .setSubject(input.aggregatorId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getKey());
  return { token, expiresAt };
}

export interface VerifyOk {
  ok: true;
  aggregatorId: string;
  intent: 'approve' | 'reject';
}

export interface VerifyErr {
  ok: false;
  error: { code: 'EXPIRED' | 'INVALID' | 'MALFORMED'; message: string };
}

export type VerifyResult = VerifyOk | VerifyErr;

/**
 * Verifies a token's signature and required claims.
 *
 * @param token - Raw JWT string from the admin email link.
 * @returns Parsed aggregator id + intent on success; structured error on failure.
 */
export async function verifyApprovalToken(token: string): Promise<VerifyResult> {
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
    const intent = payload.intent;
    if (intent !== 'approve' && intent !== 'reject') {
      return { ok: false, error: { code: 'INVALID', message: 'bad intent claim' } };
    }
    return { ok: true, aggregatorId: payload.sub, intent };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, error: { code: 'EXPIRED', message: 'token expired' } };
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
}

/** Test helper — clears cached key so env changes take effect. */
export function _resetTokenKey(): void {
  cachedKey = null;
}

// ─── Applicant verification token ────────────────────────────────────────────

const VERIFICATION_AUDIENCE = 'aggregator-applicant';

export interface MintVerificationInput {
  registrationId: string;
  /** Lifetime in seconds. Defaults to `REGISTRATION_VERIFICATION_TTL_MINUTES * 60`. */
  ttlSec?: number;
}

/**
 * Issues a signed verification token bound to a registration row.
 *
 * Sent to the applicant's email/phone at submit time so they can prove
 * ownership before the registration advances to `verified`.
 *
 * @param input - Registration id and optional TTL.
 * @returns Token string and absolute expiry timestamp.
 */
export async function mintVerificationToken(input: MintVerificationInput): Promise<MintResult> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({ intent: 'verify' })
    .setProtectedHeader({ alg: ALG })
    .setSubject(input.registrationId)
    .setIssuer(ISSUER)
    .setAudience(VERIFICATION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getKey());
  return { token, expiresAt };
}

export interface VerificationOk {
  ok: true;
  registrationId: string;
}

export type VerificationResult = VerificationOk | VerifyErr;

/**
 * Verifies an applicant verification token.
 *
 * @param token - Raw JWT string from the verification email link.
 * @returns Registration id on success; structured error on failure.
 */
export async function verifyVerificationToken(token: string): Promise<VerificationResult> {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: { code: 'MALFORMED', message: 'token is not a JWT' } };
  }
  try {
    const { payload } = await jwtVerify(token, getKey(), {
      issuer: ISSUER,
      audience: VERIFICATION_AUDIENCE,
      algorithms: [ALG],
    });
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub claim' } };
    }
    if (payload.intent !== 'verify') {
      return { ok: false, error: { code: 'INVALID', message: 'bad intent claim' } };
    }
    return { ok: true, registrationId: payload.sub };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, error: { code: 'EXPIRED', message: 'token expired' } };
    }
    if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
      return { ok: false, error: { code: 'MALFORMED', message: (err as Error).message } };
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, error: { code: 'INVALID', message: 'signature failed' } };
    }
    return {
      ok: false,
      error: { code: 'INVALID', message: err instanceof Error ? err.message : 'verify failed' },
    };
  }
}

// ─── Registration approval token (new FSM flow) ───────────────────────────────

export interface MintRegistrationApprovalInput {
  registrationId: string;
  intent: 'approve' | 'reject';
  /** Lifetime in seconds. Default 1h. */
  ttlSec?: number;
}

export interface RegistrationApprovalOk {
  ok: true;
  registrationId: string;
  intent: 'approve' | 'reject';
}

export type RegistrationApprovalResult = RegistrationApprovalOk | VerifyErr;

/**
 * Issues a signed approval token bound to a registration row + intent.
 *
 * Used in the new FSM registration flow (Part 6). Uses the same audience
 * as the legacy `mintApprovalToken` so the admin email link format is
 * compatible, but the `sub` carries the `registrationId` (not an
 * `aggregatorId`) so the approve/reject route can look up the FSM row.
 *
 * @param input - Registration id, intent, optional TTL.
 * @returns Token string and absolute expiry timestamp.
 */
export async function mintRegistrationApprovalToken(
  input: MintRegistrationApprovalInput,
): Promise<MintResult> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({ intent: input.intent })
    .setProtectedHeader({ alg: ALG })
    .setSubject(input.registrationId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getKey());
  return { token, expiresAt };
}

/**
 * Verifies a registration approval token.
 *
 * @param token - Raw JWT string from the admin email link.
 * @returns Registration id + intent on success; structured error on failure.
 */
export async function verifyRegistrationApprovalToken(
  token: string,
): Promise<RegistrationApprovalResult> {
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
    const intent = payload.intent;
    if (intent !== 'approve' && intent !== 'reject') {
      return { ok: false, error: { code: 'INVALID', message: 'bad intent claim' } };
    }
    return { ok: true, registrationId: payload.sub, intent };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, error: { code: 'EXPIRED', message: 'token expired' } };
    }
    if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
      return { ok: false, error: { code: 'MALFORMED', message: (err as Error).message } };
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, error: { code: 'INVALID', message: 'signature failed' } };
    }
    return {
      ok: false,
      error: { code: 'INVALID', message: err instanceof Error ? err.message : 'verify failed' },
    };
  }
}
