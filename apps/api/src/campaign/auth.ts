/**
 * Authentication for the api app's campaign routes, and the system gate for the non-PII dump route.
 *
 * Org-scoped `/v1/campaign/*` routes accept only tokens from the campaign-manager
 * client(s) (`CAMPAIGN_MANAGER_ALLOWED_AZP`, default `campaign-manager`). Other
 * routes reject those tokens. The caller's Signals org id is the
 * `signalstack_org_id` claim.
 *
 * The same client also issues the system (client credentials) token for the
 * dump route. `requireCampaignAuth` rejects the system username;
 * `requireCampaignSystemAuth` requires it.
 *
 * @module @aggregator-dpg/api
 */
import type { FastifyRequest } from 'fastify';
import { authenticate, authenticateAny, type AuthContext } from '../services/auth/access-token.js';
import { campaignDumpServiceAccount, campaignManagerAllowedAzp } from '../config.js';
import { httpError, type HttpError } from '../errors/http-error.js';
import { callerFromAuth, enforceRouteAccess } from '../services/authz/index.js';

/**
 * Authenticates a campaign request and returns the auth context, or throws the
 * catalogue error (401/403).
 *
 * @param req - The inbound request carrying the Bearer token.
 * @returns The verified {@link AuthContext}.
 * @throws `UNAUTHORIZED`/`FORBIDDEN` when auth fails; `FORBIDDEN` for the campaign-manager system token.
 */
export async function requireCampaignAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (!result.ok) {
    const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
    throw httpError(code, { detail: result.error.message, fields: { reason: result.error.code } });
  }
  // The system token shares this client's `azp`. Reject it here even if it was
  // given an `aggregator_id` by mistake, so it can never reach org-scoped PII.
  if (result.context.preferredUsername === campaignDumpServiceAccount()) {
    throw httpError('FORBIDDEN', {
      detail: 'the campaign-manager system token cannot access org-scoped campaign routes',
      fields: { reason: 'SYSTEM_TOKEN_NOT_PERMITTED' },
    });
  }
  await enforceRouteAccess(req, callerFromAuth(result.context));
  return result.context;
}

/**
 * Resolves the caller's Signals org id from the auth context, or throws 403.
 *
 * @param auth - The verified auth context.
 * @returns The non-empty `signalstack_org_id`.
 * @throws `FORBIDDEN` when the token carries no `signalstack_org_id` claim.
 */
export function requireOrgId(auth: AuthContext): string {
  if (!auth.signalstackOrgId) {
    throw httpError('FORBIDDEN', {
      detail: 'token has no signalstack_org_id claim',
      fields: { reason: 'MISSING_SIGNALSTACK_ORG' },
    });
  }
  return auth.signalstackOrgId;
}

/** Identity of a verified campaign-manager system caller, for audit logging. */
export interface CampaignSystemContext {
  /** Token `sub` — the service-account user id. */
  subject: string;
  /** Token `azp` — the client that requested the token. */
  azp: string | undefined;
  /** Token `preferred_username` — the matched service-account username. */
  username: string;
}

/**
 * Outcome of {@link requireCampaignSystemAuth}.
 *
 * Returned rather than thrown so the route can audit-log denials too.
 * `subject` is set only when the token was valid but failed the username match.
 */
export type CampaignSystemAuthResult =
  { ok: true; context: CampaignSystemContext } | { ok: false; error: HttpError; subject?: string };

/**
 * Authenticates the campaign-manager system caller for the whole-network non-PII dump route.
 *
 * Needs no `aggregator_id` or `signalstack_org_id`. This check is the route's
 * only control, so it requires an exact `preferred_username` match rather than
 * relying on a missing claim.
 *
 * @param req - The inbound request carrying the Bearer token.
 * @returns The verified context, or the error to throw and the subject when known.
 *   The error is 401 for a missing or invalid token, 403 for the wrong client or account.
 */
export async function requireCampaignSystemAuth(
  req: FastifyRequest,
): Promise<CampaignSystemAuthResult> {
  const result = await authenticateAny(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (!result.ok) {
    // Wrong client is 403; missing or invalid token is 401. No subject is known here.
    const isAzp = result.error.code === 'AZP_NOT_ALLOWED';
    return {
      ok: false,
      error: httpError(isAzp ? 'FORBIDDEN' : 'UNAUTHORIZED', {
        detail: result.error.message,
        fields: { reason: result.error.code },
      }),
    };
  }
  const expected = campaignDumpServiceAccount();
  if (result.context.preferredUsername !== expected) {
    return {
      ok: false,
      subject: result.context.subject,
      error: httpError('FORBIDDEN', {
        detail: 'this route requires the campaign-manager system (client_credentials) token',
        fields: { reason: 'NOT_SYSTEM_CLIENT' },
      }),
    };
  }
  return {
    ok: true,
    context: {
      subject: result.context.subject,
      azp: result.context.authorizedParty,
      username: result.context.preferredUsername,
    },
  };
}
