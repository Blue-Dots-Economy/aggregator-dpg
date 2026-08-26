/**
 * Shared authentication for the campaign routes (#579).
 *
 * Every `/v1/campaign/*` route authenticates the same way: a Keycloak Bearer
 * token scoped to the campaign-manager client(s) via the
 * `CAMPAIGN_MANAGER_ALLOWED_AZP` override (default `campaign-manager`). A
 * portal/api/bff token is rejected here, and a campaign-manager token is in
 * turn rejected by every other route (default-deny both ways). The caller's
 * Signals org id is the token's `signalstack_org_id` claim.
 *
 * @module @aggregator-dpg/api
 */
import type { FastifyRequest } from 'fastify';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { campaignManagerAllowedAzp } from '../config.js';
import { httpError } from '../errors/http-error.js';

/**
 * Authenticates a campaign request and returns the auth context, or throws the
 * catalogue error (401/403).
 *
 * @param req - The inbound request carrying the Bearer token.
 * @returns The verified {@link AuthContext}.
 * @throws The `UNAUTHORIZED`/`FORBIDDEN` http error when auth fails.
 */
export async function requireCampaignAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, { detail: result.error.message, fields: { reason: result.error.code } });
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
