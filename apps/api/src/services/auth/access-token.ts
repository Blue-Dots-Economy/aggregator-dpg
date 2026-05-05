/**
 * Access-token verification.
 *
 * Validates the `Authorization: Bearer ...` header against the Keycloak
 * realm's JWKS, then projects a small claims subset into a strongly-typed
 * `AuthContext`. The route handlers use that context for authorisation —
 * never the raw token.
 */

import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | null = null;
let testOverride: ((token: string) => Promise<JWTPayload>) | null = null;

export interface AuthContext {
  /** Keycloak `sub` claim — stable user id. */
  userId: string;
  /** Custom claim mapped from the `aggregator_id` user attribute. */
  aggregatorId: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
}

export type AuthError =
  | { code: 'MISSING_TOKEN'; message: string }
  | { code: 'INVALID_TOKEN'; message: string }
  | { code: 'MISSING_AGGREGATOR_ID'; message: string };

export type AuthResult = { ok: true; context: AuthContext } | { ok: false; error: AuthError };

export interface AnyAuthContext {
  /** `sub` claim. For service tokens this is the service-account user id. */
  subject: string;
  /** `azp` claim — the client that requested the token. */
  authorizedParty?: string;
  /** Token's `client_id` claim (Keycloak emits this on service-account tokens). */
  clientId?: string;
  /** Whether this token is bound to an end user (has `aggregator_id`). */
  isUser: boolean;
  aggregatorId?: string;
  email?: string;
}

export type AnyAuthResult =
  | { ok: true; context: AnyAuthContext }
  | {
      ok: false;
      error: { code: 'MISSING_TOKEN' | 'INVALID_TOKEN'; message: string };
    };

/**
 * Verifies the Bearer token on a Fastify request and returns an
 * `AuthContext`.
 */
export async function authenticate(req: FastifyRequest): Promise<AuthResult> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return { ok: false, error: { code: 'MISSING_TOKEN', message: 'missing Bearer token' } };
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return { ok: false, error: { code: 'MISSING_TOKEN', message: 'empty Bearer token' } };
  }

  let payload: JWTPayload;
  try {
    if (testOverride) {
      payload = await testOverride(token);
    } else {
      const jwks = getJwks();
      const issuer = expectedIssuer();
      const { payload: verified } = await jwtVerify(token, jwks, { issuer });
      payload = verified;
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'INVALID_TOKEN',
        message: err instanceof Error ? err.message : 'verify failed',
      },
    };
  }

  if (!payload.sub) {
    return { ok: false, error: { code: 'INVALID_TOKEN', message: 'missing sub claim' } };
  }
  const aggregatorId = readAggregatorId(payload);
  if (!aggregatorId) {
    return {
      ok: false,
      error: {
        code: 'MISSING_AGGREGATOR_ID',
        message: 'token has no aggregator_id claim',
      },
    };
  }
  const ctx: AuthContext = {
    userId: payload.sub,
    aggregatorId,
  };
  const claims = payload as Record<string, unknown>;
  if (typeof claims.email === 'string') ctx.email = claims.email;
  if (typeof claims.email_verified === 'boolean') ctx.emailVerified = claims.email_verified;
  if (typeof claims.preferred_username === 'string') {
    ctx.preferredUsername = claims.preferred_username;
  }
  if (typeof claims.given_name === 'string') ctx.firstName = claims.given_name;
  if (typeof claims.family_name === 'string') ctx.lastName = claims.family_name;
  const phone = readStringOrFirst(claims.phone_number ?? claims.phoneNumber);
  if (phone) ctx.phoneNumber = phone;
  const phoneVerified = claims.phone_number_verified ?? claims.phoneNumberVerified;
  if (typeof phoneVerified === 'boolean') ctx.phoneNumberVerified = phoneVerified;
  else if (typeof phoneVerified === 'string') ctx.phoneNumberVerified = phoneVerified === 'true';
  return { ok: true, context: ctx };
}

/**
 * Verifies the Bearer token signature against the Keycloak JWKS without
 * requiring an `aggregator_id` claim. Use this on routes that may be
 * reached anonymously through the BFF (which then attaches a Keycloak
 * service-account token via the client_credentials grant).
 *
 * The middleware succeeds for both end-user tokens and service tokens.
 * Handlers can branch on `context.isUser` if they need to behave differently.
 */
export async function authenticateAny(req: FastifyRequest): Promise<AnyAuthResult> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return { ok: false, error: { code: 'MISSING_TOKEN', message: 'missing Bearer token' } };
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return { ok: false, error: { code: 'MISSING_TOKEN', message: 'empty Bearer token' } };
  }

  let payload: JWTPayload;
  try {
    if (testOverride) {
      payload = await testOverride(token);
    } else {
      const jwks = getJwks();
      const issuer = expectedIssuer();
      const { payload: verified } = await jwtVerify(token, jwks, { issuer });
      payload = verified;
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'INVALID_TOKEN',
        message: err instanceof Error ? err.message : 'verify failed',
      },
    };
  }
  if (!payload.sub) {
    return { ok: false, error: { code: 'INVALID_TOKEN', message: 'missing sub claim' } };
  }
  const claims = payload as Record<string, unknown>;
  const aggregatorId = readAggregatorId(payload);
  const ctx: AnyAuthContext = {
    subject: payload.sub,
    isUser: Boolean(aggregatorId),
  };
  if (typeof claims.azp === 'string') ctx.authorizedParty = claims.azp;
  if (typeof claims.client_id === 'string') ctx.clientId = claims.client_id;
  if (aggregatorId) ctx.aggregatorId = aggregatorId;
  if (typeof claims.email === 'string') ctx.email = claims.email;
  return { ok: true, context: ctx };
}

function readStringOrFirst(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function readAggregatorId(payload: JWTPayload): string | undefined {
  // Keycloak protocol mappers can publish a user attribute as either a
  // single string or a one-element array claim — accept both shapes.
  const direct = (payload as Record<string, unknown>).aggregator_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return undefined;
}

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  const url = jwksUrl();
  if (cachedJwks && cachedJwksUrl === url) return cachedJwks;
  cachedJwks = createRemoteJWKSet(new URL(url));
  cachedJwksUrl = url;
  return cachedJwks;
}

function jwksUrl(): string {
  const base = mustEnv('KEYCLOAK_URL');
  const realm = mustEnv('KEYCLOAK_REALM');
  return `${base.replace(/\/+$/, '')}/realms/${realm}/protocol/openid-connect/certs`;
}

function expectedIssuer(): string {
  const base = mustEnv('KEYCLOAK_URL');
  const realm = mustEnv('KEYCLOAK_REALM');
  return `${base.replace(/\/+$/, '')}/realms/${realm}`;
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

/** Test helper — supply a fake token verifier. */
export function _setAccessTokenVerifier(fn: ((token: string) => Promise<JWTPayload>) | null): void {
  testOverride = fn;
}

/** Test helper — clear cached JWKS. */
export function _resetJwks(): void {
  cachedJwks = null;
  cachedJwksUrl = null;
}
