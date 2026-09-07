/**
 * Coordinator invite-token mint and verify (#700).
 *
 * Mirrors `approval-token.ts`: HS256 via `jose`, issuer `aggregator-api`,
 * secret reused from `APPROVAL_TOKEN_SECRET`. The distinguishing claim is the
 * **audience `aggregator-invite`**, so an approval/admin token can never be
 * replayed as an invite (and vice versa) even though they share a secret.
 *
 * The token carries the invite's identity (`sub` = the `registration_invites`
 * row `jti`), the org it admits to (`org`), and the bound recipient (`email`,
 * enforced on submit). Single-use is NOT a token property — it is the DB row's
 * `pending → consumed` CAS; the token only proves who/what/where.
 */

import { SignJWT } from 'jose';
import {
  TOKEN_ALG,
  TOKEN_ISSUER,
  getTokenKey,
  isJwtLike,
  verifyJwt,
  mapJoseError,
  _resetTokenKeyCache,
} from './token-common.js';

const AUDIENCE = 'aggregator-invite';
const INVITE_ROLE = 'coordinator';
/** 14 days — overridable per-call via `ttlSec` (`INVITE_TOKEN_TTL_SECONDS`). */
const DEFAULT_TTL_SEC = 14 * 24 * 60 * 60;

/** The single invite role in this phase. */
export type InviteRole = typeof INVITE_ROLE;

export interface MintInviteInput {
  /** `jti` of the `registration_invites` row this token represents. */
  jti: string;
  /** `parent_org_id` the invite admits the coordinator to. */
  org: string;
  /** Invited email — bound; enforced against the submitted email. */
  email: string;
  /** Lifetime in seconds. Default 14 days. */
  ttlSec?: number;
}

export interface MintInviteResult {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a signed coordinator-invite token bound to an invite row, org, and
 * recipient email.
 *
 * @param input - Invite `jti`, `org` (parent_org_id), bound `email`, optional TTL.
 * @returns The token string and its absolute expiry timestamp.
 * @throws {Error} If `APPROVAL_TOKEN_SECRET` is unset or too short.
 */
export async function mintInviteToken(input: MintInviteInput): Promise<MintInviteResult> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({ role: INVITE_ROLE, org: input.org, email: input.email })
    .setProtectedHeader({ alg: TOKEN_ALG })
    .setSubject(input.jti)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getTokenKey());
  return { token, expiresAt };
}

export interface VerifyInviteOk {
  ok: true;
  /** `jti` of the invite row (token `sub`). */
  jti: string;
  role: InviteRole;
  /** `parent_org_id` from the token. */
  org: string;
  /** Bound recipient email (normalised at mint time). */
  email: string;
}

export interface VerifyInviteErr {
  ok: false;
  error: { code: 'EXPIRED' | 'INVALID' | 'MALFORMED'; message: string };
}

export type VerifyInviteResult = VerifyInviteOk | VerifyInviteErr;

/**
 * Verifies an invite token's signature, audience, issuer, expiry, and required
 * claims. Unlike the approval token there is no `allowExpired` mode: an expired
 * invite has no in-app recovery — the owner re-mints (§6), so the caller only
 * ever needs a strict verify.
 *
 * @param token - Raw JWT string from the coordinator invite link.
 * @returns Parsed `jti` / `org` / `email` / `role` on success; structured error otherwise.
 */
export async function verifyInviteToken(token: string): Promise<VerifyInviteResult> {
  if (!isJwtLike(token)) {
    return { ok: false, error: { code: 'MALFORMED', message: 'token is not a JWT' } };
  }
  try {
    const payload = await verifyJwt(token, AUDIENCE);
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub claim' } };
    }
    if (payload.role !== INVITE_ROLE) {
      return { ok: false, error: { code: 'INVALID', message: 'bad role claim' } };
    }
    const org = typeof payload.org === 'string' ? payload.org : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (!org || !email) {
      return { ok: false, error: { code: 'INVALID', message: 'missing org/email claim' } };
    }
    return { ok: true, jti: payload.sub, role: INVITE_ROLE, org, email };
  } catch (err) {
    return { ok: false, error: mapJoseError(err) };
  }
}

/** Test helper — clears the cached key so env changes take effect. */
export function _resetInviteTokenKey(): void {
  _resetTokenKeyCache();
}
