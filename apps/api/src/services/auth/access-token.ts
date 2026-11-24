/**
 * Access-token verification, in the aggregator API (`@aggregator-dpg/api`).
 *
 * Verifies the `Authorization: Bearer` token against the Keycloak realm's
 * JWKS and maps selected claims into an `AuthContext`. Handlers authorise
 * from that context, never the raw token.
 */

import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';
import { getUserStore } from '../user-store/index.js';
import { servedDomains } from '../user-store/serves.js';
import type { ProfileType } from '@aggregator-dpg/shared-primitives/aggregator';
import { getIdpAdmin } from '../idp-admin/index.js';
import { KC_ATTR } from '../idp-admin/attributes.js';
import { getSignalStackWriter } from '../signalstack.js';
import { getNetworkConfig } from '../network-config.js';
import { logger } from '../../logger.js';
import { stripTrailingSlashes } from '@aggregator-dpg/shared-primitives/url';
import { readUserIdClaim } from '@aggregator-dpg/shared-primitives/user-id-claim';
import { recordLoginIdentity } from '../identity-store/record.js';
import type { Coordinator } from '../user-store/interface.js';
import { logActing, readActingHeader, resolveActingAccount } from './acting.js';

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | null = null;
let testOverride: ((token: string) => Promise<JWTPayload>) | null = null;

export interface AuthContext {
  /** Keycloak `sub` claim — stable user id. */
  userId: string;
  /** The `user_id` claim, else the `aggregator_id` claim: the user's `users.id`. */
  aggregatorId: string;
  /**
   * The profile types the coordinator serves, from the multivalued
   * `aggregator_type` claim; `[]` when absent. Set when the token is issued; a
   * token refresh picks up a change, and the console ends the coordinator's
   * sessions so a change takes effect at once.
   */
  serves: ProfileType[];
  /**
   * Approval state from the `decision_made` claim; `'pending'` until decided.
   * {@link requireApproved} rejects anything other than `'approved'`.
   */
  decisionMade?: 'pending' | 'approved' | 'rejected';
  /**
   * Signalstack organisation id from the `signalstack_org_id` claim. Written at
   * approval and backfilled at login when missing, so it may be absent; handlers
   * that need it should use the fallback helper.
   */
  signalstackOrgId?: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  /**
   * `azp` claim: the client that requested the token. Recorded as the audit
   * log's actor client.
   */
  azp?: string;
  /**
   * Set when an org owner acts as its own coordinator account
   * (`x-acting-account`). The login is the owner's, so nothing records it
   * as the coordinator's login.
   */
  acting?: true;
}

export type AuthError =
  | { code: 'MISSING_TOKEN'; message: string }
  | { code: 'INVALID_TOKEN'; message: string }
  | { code: 'MISSING_AGGREGATOR_ID'; message: string }
  | { code: 'NOT_APPROVED'; message: string }
  /** `x-acting-account` names an account this login may not act as (403). */
  | { code: 'ACTING_ACCOUNT_INVALID'; message: string }
  /** A store failed while checking `x-acting-account` (503). */
  | { code: 'ACTING_UNAVAILABLE'; message: string };

export type AuthResult = { ok: true; context: AuthContext } | { ok: false; error: AuthError };

export interface AnyAuthContext {
  /** `sub` claim. For service tokens this is the service-account user id. */
  subject: string;
  /** `azp` claim — the client that requested the token. */
  authorizedParty?: string;
  /** Token's `client_id` claim (Keycloak emits this on service-account tokens). */
  clientId?: string;
  /**
   * `preferred_username` claim. Keycloak sets it to `service-account-<client>`
   * for a service account and to the username for a user, so it tells a
   * client_credentials token from a password-grant token on the same client.
   * `azp` and `sub` cannot.
   */
  preferredUsername?: string;
  /** Whether this token is bound to an end user (has `user_id` or `aggregator_id`). */
  isUser: boolean;
  aggregatorId?: string;
  email?: string;
}

export type AnyAuthResult =
  | { ok: true; context: AnyAuthContext }
  | {
      ok: false;
      error: { code: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'AZP_NOT_ALLOWED'; message: string };
    };

/**
 * Verifies the Bearer token on a request and returns an `AuthContext`.
 *
 * @param req - The Fastify request.
 * @param opts.allowedAzp - `azp` allow-list that replaces `KEYCLOAK_ALLOWED_AZP`
 *   for this call, to limit one endpoint to a specific client.
 */
export async function authenticate(
  req: FastifyRequest,
  opts?: { allowedAzp?: readonly string[] },
): Promise<AuthResult> {
  const verified = await verifyRequest(req, opts);
  if (!verified.ok) return verified;
  const { sub, payload } = verified;
  const claim = readUserIdClaim(payload);
  if (claim.kind === 'mismatch') return claimMismatch(sub);
  if (claim.kind === 'absent') return missingAggregatorId();
  return { ok: true, context: hydrateContext(sub, claim.userId, payload) };
}

/** A verified Bearer token: its `sub` and claims. */
type VerifiedRequest =
  { ok: true; sub: string; payload: JWTPayload } | { ok: false; error: AuthError };

/**
 * Verifies the request's Bearer token and requires a `sub` claim.
 *
 * @param req - The Fastify request.
 * @param opts.allowedAzp - `azp` allow-list that replaces `KEYCLOAK_ALLOWED_AZP`.
 * @returns The subject and claims, or `MISSING_TOKEN` / `INVALID_TOKEN`.
 */
async function verifyRequest(
  req: FastifyRequest,
  opts?: { allowedAzp?: readonly string[] },
): Promise<VerifiedRequest> {
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
    payload = await verifyToken(token, opts?.allowedAzp);
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
  return { ok: true, sub: payload.sub, payload };
}

function missingAggregatorId(): AuthResult {
  return {
    ok: false,
    error: { code: 'MISSING_AGGREGATOR_ID', message: 'token has no aggregator_id claim' },
  };
}

/**
 * Rejects a token whose `user_id` and `aggregator_id` claims differ: it cannot
 * be trusted to name one user, so it is treated as an invalid token (401).
 *
 * @param sub - The token subject, logged so the account can be found.
 */
function claimMismatch(sub: string): {
  ok: false;
  error: { code: 'INVALID_TOKEN'; message: string };
} {
  logger.warn({
    operation: 'auth.user_id_claim',
    status: 'failure',
    error: 'CLAIM_MISMATCH',
    sub,
  });
  return {
    ok: false,
    error: { code: 'INVALID_TOKEN', message: 'token user_id and aggregator_id claims differ' },
  };
}

function actingInvalid(message: string): AuthResult {
  return { ok: false, error: { code: 'ACTING_ACCOUNT_INVALID', message } };
}

/**
 * Builds an {@link AuthContext} from a verified token's optional claims.
 *
 * @param userId - The token `sub`.
 * @param aggregatorId - The resolved `aggregator_id`.
 * @param payload - The verified JWT payload.
 * @returns The auth context; optional fields set only when present.
 */
function hydrateContext(userId: string, aggregatorId: string, payload: JWTPayload): AuthContext {
  const claims: Record<string, unknown> = payload;
  const ctx: AuthContext = {
    userId,
    aggregatorId,
    serves: readStringList(claims.aggregator_type),
    ...identityOf(payload),
  };
  const decision = readStringOrFirst(claims.decision_made);
  if (decision === 'pending' || decision === 'approved' || decision === 'rejected') {
    ctx.decisionMade = decision;
  }
  const signalstackOrgId = readStringOrFirst(claims.signalstack_org_id);
  if (signalstackOrgId) ctx.signalstackOrgId = signalstackOrgId;
  return ctx;
}

/** The identity fields of an {@link AuthContext}, read from the token. */
type TokenIdentityFields = Pick<
  AuthContext,
  | 'email'
  | 'emailVerified'
  | 'preferredUsername'
  | 'azp'
  | 'firstName'
  | 'lastName'
  | 'phoneNumber'
  | 'phoneNumberVerified'
>;

/**
 * Reads the caller's identity claims (email, names, phone, client).
 *
 * @param payload - The verified JWT payload.
 * @returns The fields present in the token.
 */
function identityOf(payload: JWTPayload): TokenIdentityFields {
  const claims: Record<string, unknown> = payload;
  const ctx: TokenIdentityFields = {};
  if (typeof claims.email === 'string') ctx.email = claims.email;
  if (typeof claims.email_verified === 'boolean') ctx.emailVerified = claims.email_verified;
  if (typeof claims.preferred_username === 'string') {
    ctx.preferredUsername = claims.preferred_username;
  }
  if (typeof claims.azp === 'string') ctx.azp = claims.azp;
  if (typeof claims.given_name === 'string') ctx.firstName = claims.given_name;
  if (typeof claims.family_name === 'string') ctx.lastName = claims.family_name;
  const phone = readStringOrFirst(claims.phone_number ?? claims.phoneNumber);
  if (phone) ctx.phoneNumber = phone;
  const phoneVerified = claims.phone_number_verified ?? claims.phoneNumberVerified;
  if (typeof phoneVerified === 'boolean') ctx.phoneNumberVerified = phoneVerified;
  else if (typeof phoneVerified === 'string') ctx.phoneNumberVerified = phoneVerified === 'true';
  return ctx;
}

/**
 * The approval state of a coordinator row, in `decision_made` terms.
 *
 * @param status - The row's registration status.
 * @returns `approved` for an active row, `pending` for a pending one, else `rejected`.
 */
function decisionOf(status: Coordinator['status']): NonNullable<AuthContext['decisionMade']> {
  if (status === 'active') return 'approved';
  if (status === 'pending') return 'pending';
  return 'rejected';
}

/**
 * Builds the {@link AuthContext} of an owner acting as its own coordinator
 * account. The account fields come from the coordinator row; the token
 * supplies only the identity fields.
 *
 * @param sub - The token `sub`.
 * @param accountId - The `x-acting-account` value.
 * @param payload - The verified JWT payload.
 * @returns The context, `ACTING_ACCOUNT_INVALID`, or `ACTING_UNAVAILABLE`.
 */
async function actingContext(
  sub: string,
  accountId: string,
  payload: JWTPayload,
): Promise<AuthResult> {
  const acting = await resolveActingAccount(sub, accountId);
  if (!acting.success) {
    logActing(acting.error.code);
    const code =
      acting.error.code === 'UNAVAILABLE' ? 'ACTING_UNAVAILABLE' : 'ACTING_ACCOUNT_INVALID';
    return { ok: false, error: { code, message: acting.error.message } };
  }
  logActing(null);
  const row = acting.value;
  const ctx: AuthContext = {
    userId: sub,
    aggregatorId: row.id,
    serves: row.serves,
    decisionMade: decisionOf(row.status),
    ...identityOf(payload),
    acting: true,
  };
  if (row.signalstackOrgId) ctx.signalstackOrgId = row.signalstackOrgId;
  return { ok: true, context: ctx };
}

/**
 * {@link authenticate} that also accepts an org owner acting as its own
 * coordinator account (`x-acting-account`, see {@link requireApproved}).
 * Runs no approval gate, backfill or login record, so a route that must show
 * a pending account (the profile self-read) can use it.
 *
 * @param req - The Fastify request.
 * @returns The context (`acting: true` when acting) or the auth error.
 */
export async function authenticateAllowingActing(req: FastifyRequest): Promise<AuthResult> {
  const verified = await verifyRequest(req);
  if (!verified.ok) return verified;
  const { sub, payload } = verified;
  const acting = readActingHeader(req);
  if (acting.kind === 'malformed') {
    logActing('MALFORMED');
    return actingInvalid('x-acting-account is not an account id');
  }
  const claim = readUserIdClaim(payload);
  if (claim.kind === 'mismatch') return claimMismatch(sub);
  if (claim.kind === 'absent') {
    if (acting.kind === 'absent') return missingAggregatorId();
    return actingContext(sub, acting.id, payload);
  }
  const claimed = claim.userId;
  if (acting.kind === 'account' && acting.id !== claimed.toLowerCase()) {
    logActing('CLAIM_MISMATCH');
    return actingInvalid('x-acting-account differs from the token aggregator_id');
  }
  return { ok: true, context: hydrateContext(sub, claimed, payload) };
}

/**
 * {@link authenticate} plus the approval gate. Rejects with `NOT_APPROVED`
 * unless `decision_made` is `'approved'`. Use on business endpoints; not on
 * `/auth/*` or the profile self-read, which must show "pending".
 *
 * When the token lacks `signalstack_org_id`, backfills it first (signalstack
 * upsert, Keycloak attribute, DB row) and sets it on the context. The user's
 * token carries the claim after the next refresh. Backfill failures are
 * logged and do not block the request.
 *
 * An org owner may act as its own coordinator account by sending
 * `x-acting-account` with a token that has no `aggregator_id`. The account
 * must be the coordinator linked to this login, the login must also hold an
 * admin account, and the coordinator and its org must be active. The context
 * then comes from the coordinator row, and neither the backfill nor the
 * login record runs: both would write to the owner's login. A coordinator
 * token whose header differs from its claim is refused.
 */
export async function requireApproved(req: FastifyRequest): Promise<AuthResult> {
  const result = await authenticateAllowingActing(req);
  if (!result.ok) return result;
  if (result.context.acting) {
    if (result.context.decisionMade !== 'approved' || !result.context.signalstackOrgId) {
      return {
        ok: false,
        error: { code: 'NOT_APPROVED', message: 'acting account has no signalstack organisation' },
      };
    }
    return result;
  }
  if (result.context.decisionMade !== 'approved') {
    return {
      ok: false,
      error: {
        code: 'NOT_APPROVED',
        message: `aggregator approval pending (decision_made=${result.context.decisionMade ?? 'absent'})`,
      },
    };
  }
  if (!result.context.signalstackOrgId) {
    await backfillSignalstackOrgId(result.context);
  }
  // Record the coordinator's IdP login once per process per user; best-effort.
  await recordLoginIdentity(
    result.context.aggregatorId,
    result.context.userId,
    'auth.recordIdentity',
  );
  return result;
}

/**
 * Best-effort backfill of `signalstack_org_id` for the authenticated user.
 *
 * Idempotent: the signalstack upsert dedupes on `external_id`. Sets the value
 * on the context when resolved; logs and returns on every failure.
 */
async function backfillSignalstackOrgId(ctx: AuthContext): Promise<void> {
  const start = Date.now();
  const log = logger.child({
    operation: 'auth.backfillSignalstackOrgId',
    aggregator_id: ctx.aggregatorId,
    user_id: ctx.userId,
  });

  const signalstack = getSignalStackWriter();
  if (!signalstack) {
    log.debug({ status: 'skipped', reason: 'signalstack_disabled' });
    return;
  }

  const store = getUserStore();
  const found = await store.findById(ctx.aggregatorId);
  if (!found.ok) {
    log.warn(
      { status: 'failure', sub_operation: 'userStore.findById', code: found.error.code },
      'aggregator lookup failed during signalstack backfill',
    );
    return;
  }
  if (!found.value) {
    log.warn(
      { status: 'failure', sub_operation: 'userStore.findById', reason: 'not_found' },
      'aggregator row missing for approved KC user — manual cleanup required',
    );
    return;
  }

  // Every profile type the coordinator serves, filtered by the live network
  // config so no stale id reaches org.metadata.domains. With none left the
  // domains are not sent and Signals keeps the org's current list.
  const networkCfg = await getNetworkConfig();
  const served = servedDomains(found.value.serves, networkCfg.domainIds);
  if (served.length === 0) {
    log.warn(
      { status: 'skipped', sub_operation: 'signalstack.upsertAggregator.domains' },
      'coordinator serves no network profile type; domains not sent',
    );
  }
  const upsert = await signalstack.upsertAggregator({
    external_id: ctx.aggregatorId,
    name: found.value.name,
    slug: found.value.orgSlug,
    ...(served.length > 0 ? { domains: served } : {}),
  });
  if (!upsert.success) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'signalstack.upsertAggregator',
        code: upsert.error.code,
        cause: upsert.error.message,
        latency_ms: Date.now() - start,
      },
      'signalstack aggregator upsert failed during login fallback',
    );
    return;
  }

  const idp = getIdpAdmin();
  const orgId = upsert.value.org_id;
  // Write both the Keycloak attribute (the claim after refresh) and the DB
  // column (read by the worker and public-link submit). The context is updated
  // in memory for the current request.
  const [attr, dbWrite] = await Promise.all([
    idp.setAttributes(ctx.userId, { [KC_ATTR.SIGNALSTACK_ORG_ID]: orgId }),
    store.updateSignalstackOrgId(ctx.aggregatorId, orgId, ctx.userId),
  ]);
  if (!attr.ok) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'idp.setAttributes.signalstack_org_id',
        code: attr.error.code,
        cause: attr.error.message,
      },
      'failed to stamp signalstack_org_id on KC user during login fallback',
    );
  }
  if (!dbWrite.ok) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'store.updateSignalstackOrgId',
        code: dbWrite.error.code,
        cause: dbWrite.error.message,
      },
      'failed to persist signalstack_org_id on aggregators row during login fallback',
    );
  }

  ctx.signalstackOrgId = orgId;
  if (attr.ok && dbWrite.ok) {
    log.info(
      {
        status: 'success',
        signalstack_org_id: orgId,
        latency_ms: Date.now() - start,
      },
      'signalstack_org_id backfilled on KC user + aggregators row',
    );
  }
}

/**
 * Verifies the Bearer token without requiring a `user_id` or `aggregator_id`
 * claim. A token whose two claims differ is still refused.
 *
 * Use on routes reached through the BFF, which attaches a service-account
 * token for anonymous callers. Accepts user and service tokens; handlers can
 * check `context.isUser`.
 *
 * @param req - The Fastify request.
 * @param opts.allowedAzp - `azp` allow-list that replaces `KEYCLOAK_ALLOWED_AZP`
 *   for this call. Used by the campaign dump route.
 * @returns `ok: true` with the {@link AnyAuthContext}; otherwise `ok: false`
 *   with `MISSING_TOKEN`, `INVALID_TOKEN`, or `AZP_NOT_ALLOWED`.
 */
export async function authenticateAny(
  req: FastifyRequest,
  opts?: { allowedAzp?: readonly string[] },
): Promise<AnyAuthResult> {
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
    payload = await verifyToken(token, opts?.allowedAzp);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: err instanceof AzpNotAllowedError ? 'AZP_NOT_ALLOWED' : 'INVALID_TOKEN',
        message: err instanceof Error ? err.message : 'verify failed',
      },
    };
  }
  if (!payload.sub) {
    return { ok: false, error: { code: 'INVALID_TOKEN', message: 'missing sub claim' } };
  }
  const claims = payload as Record<string, unknown>;
  const claim = readUserIdClaim(payload);
  if (claim.kind === 'mismatch') return claimMismatch(payload.sub);
  const aggregatorId = claim.kind === 'present' ? claim.userId : undefined;
  const ctx: AnyAuthContext = {
    subject: payload.sub,
    isUser: Boolean(aggregatorId),
  };
  if (typeof claims.azp === 'string') ctx.authorizedParty = claims.azp;
  if (typeof claims.client_id === 'string') ctx.clientId = claims.client_id;
  if (typeof claims.preferred_username === 'string') {
    ctx.preferredUsername = claims.preferred_username;
  }
  if (aggregatorId) ctx.aggregatorId = aggregatorId;
  if (typeof claims.email === 'string') ctx.email = claims.email;
  return { ok: true, context: ctx };
}

/**
 * Reads a claim a mapper may publish as a string or a list of strings.
 *
 * @param v - The raw claim value.
 * @returns The non-empty strings, without repeats; `[]` when absent.
 */
function readStringList(v: unknown): string[] {
  const values = Array.isArray(v) ? v : [v];
  return [...new Set(values.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

function readStringOrFirst(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/**
 * Thrown when a token's `azp` is not in the allow-list, so callers can answer
 * 403 for a wrong client and 401 for a bad signature.
 */
export class AzpNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzpNotAllowedError';
  }
}

/**
 * Verifies a raw Bearer token against the Keycloak realm and returns its claims.
 *
 * Besides the signature, `iss` and `exp`, it checks:
 *
 * - `aud`: when `KEYCLOAK_EXPECTED_AUDIENCE` is set, must contain it. Needs
 *   the realm audience mapper.
 * - `azp`: when `KEYCLOAK_ALLOWED_AZP` is set, must be in that list. Keycloak
 *   always emits `azp`, so this is the main client gate.
 *
 * Each check is skipped when its env var is unset.
 *
 * @param token - The raw JWT from the `Authorization: Bearer` header.
 * @returns The verified JWT claim set.
 * @throws {Error} If verification fails, or `azp` is not in the allow-list.
 */
async function verifyToken(token: string, azpAllow?: readonly string[]): Promise<JWTPayload> {
  let payload: JWTPayload;
  if (testOverride) {
    payload = await testOverride(token);
  } else {
    const jwks = getJwks();
    const audience = expectedAudience();
    const { payload: verified } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer(),
      ...(audience ? { audience } : {}),
    });
    payload = verified;
  }
  assertAllowedAzp(payload, azpAllow);
  return payload;
}

/**
 * Rejects a token whose `azp` is not in the allow-list.
 *
 * @param payload - The verified JWT claim set.
 * @param override - Allow-list that replaces `KEYCLOAK_ALLOWED_AZP` when given.
 * @throws {Error} If an allow-list applies and `azp` is absent or not in it.
 */
function assertAllowedAzp(payload: JWTPayload, override?: readonly string[]): void {
  const allow = override ?? allowedAzp();
  if (allow.length === 0) return; // gate disabled when unconfigured
  const azp = (payload as Record<string, unknown>).azp;
  if (typeof azp !== 'string' || !allow.includes(azp)) {
    throw new AzpNotAllowedError(
      `token azp '${typeof azp === 'string' ? azp : 'absent'}' is not an allowed client`,
    );
  }
}

/** Optional expected token audience (`KEYCLOAK_EXPECTED_AUDIENCE`). */
function expectedAudience(): string | undefined {
  const v = process.env.KEYCLOAK_EXPECTED_AUDIENCE;
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** Allow-listed `azp` client ids (`KEYCLOAK_ALLOWED_AZP`, comma-separated). */
function allowedAzp(): string[] {
  const v = process.env.KEYCLOAK_ALLOWED_AZP;
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  return `${stripTrailingSlashes(base)}/realms/${realm}/protocol/openid-connect/certs`;
}

function expectedIssuer(): string {
  const base = mustEnv('KEYCLOAK_URL');
  const realm = mustEnv('KEYCLOAK_REALM');
  return `${stripTrailingSlashes(base)}/realms/${realm}`;
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
