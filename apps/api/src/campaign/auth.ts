/**
 * Shared authentication for the campaign routes (#579), and the reverse-
 * scoped system gate for the whole-network non-PII dump route (#692).
 *
 * Every org-scoped `/v1/campaign/*` route authenticates the same way: a
 * Keycloak Bearer token scoped to the campaign-manager client(s) via the
 * `CAMPAIGN_MANAGER_ALLOWED_AZP` override (default `campaign-manager`). A
 * portal/api/bff token is rejected here, and a campaign-manager token is in
 * turn rejected by every other route (default-deny both ways). The caller's
 * Signals org id is the token's `signalstack_org_id` claim.
 *
 * The `campaign-manager` client also serves the SYSTEM caller (client
 * credentials grant) that the non-PII dump route requires. That token shares
 * the same `azp` as a coordinator token on this client, so `requireCampaignAuth`
 * (the org-scoped gate) and `requireCampaignSystemAuth` (the system gate) are
 * each other's mirror image: `requireCampaignAuth` explicitly rejects the
 * system username, and `requireCampaignSystemAuth` requires it exactly.
 *
 * @module @aggregator-dpg/api
 */
import type { FastifyRequest } from 'fastify';
import { authenticate, authenticateAny, type AuthContext } from '../services/auth/access-token.js';
import { campaignDumpServiceAccount, campaignManagerAllowedAzp } from '../config.js';
import { httpError } from '../errors/http-error.js';

/**
 * Authenticates a campaign request and returns the auth context, or throws the
 * catalogue error (401/403).
 *
 * @param req - The inbound request carrying the Bearer token.
 * @returns The verified {@link AuthContext}.
 * @throws The `UNAUTHORIZED`/`FORBIDDEN` http error when auth fails, including
 *   `FORBIDDEN` when the token is the campaign-manager SYSTEM (client
 *   credentials) token — that token is scoped to the whole-network dump route
 *   only, never to an org-scoped PII route.
 */
export async function requireCampaignAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (!result.ok) {
    const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
    throw httpError(code, { detail: result.error.message, fields: { reason: result.error.code } });
  }
  // Reverse direction of the #692 split: the campaign-manager SYSTEM token
  // shares this client's `azp`, so it must be rejected explicitly here. A
  // correctly-provisioned service account already fails above for want of an
  // `aggregator_id`; this closes the misprovisioned case, where stray user
  // attributes would otherwise let a whole-network credential reach org-scoped
  // PII. Keeps the guarantee in this repo's tests rather than in realm state.
  if (result.context.preferredUsername === campaignDumpServiceAccount()) {
    throw httpError('FORBIDDEN', {
      detail: 'the campaign-manager system token cannot access org-scoped campaign routes',
      fields: { reason: 'SYSTEM_TOKEN_NOT_PERMITTED' },
    });
  }
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
 * Authenticates the campaign-manager SYSTEM caller for the whole-network
 * non-PII dump route (#692).
 *
 * Unlike {@link requireCampaignAuth} this accepts a token with no
 * `aggregator_id` and no `signalstack_org_id`, because the caller is the
 * campaign manager's own service account rather than a coordinator at an
 * aggregator. That route has no org scoping, so this identity check is its only
 * control, and it is deliberately a POSITIVE match on `preferred_username`
 * rather than an inference from an absent claim: `aggregator_id` is a Keycloak
 * user attribute, so a misprovisioned service account can carry one, and the
 * endpoint's safety must not depend on realm state this repo cannot test.
 *
 * @param req - The inbound request carrying the Bearer token.
 * @returns The verified {@link CampaignSystemContext}.
 * @throws `UNAUTHORIZED` when the token is absent or unverifiable, or
 *   `FORBIDDEN` when its `azp` is not allow-listed or it is not the expected
 *   service account.
 */
export async function requireCampaignSystemAuth(
  req: FastifyRequest,
): Promise<CampaignSystemContext> {
  const result = await authenticateAny(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (!result.ok) {
    // A wrong-client token is a 403 (the credential is valid, the client is not
    // permitted here); a missing or unverifiable token is a 401.
    const isAzp = result.error.code === 'AZP_NOT_ALLOWED';
    throw httpError(isAzp ? 'FORBIDDEN' : 'UNAUTHORIZED', {
      detail: result.error.message,
      fields: { reason: result.error.code },
    });
  }
  const expected = campaignDumpServiceAccount();
  if (result.context.preferredUsername !== expected) {
    throw httpError('FORBIDDEN', {
      detail: 'this route requires the campaign-manager system (client_credentials) token',
      fields: { reason: 'NOT_SYSTEM_CLIENT' },
    });
  }
  return {
    subject: result.context.subject,
    azp: result.context.authorizedParty,
    username: result.context.preferredUsername,
  };
}
