/**
 * Tests for the campaign auth helpers — the org-scoped coordinator gate
 * (`requireCampaignAuth`) and the whole-network system gate
 * (`requireCampaignSystemAuth`).
 *
 * The matrix here is the specification for #692: the dump route has no org
 * scoping, so the calling identity is its only control, and BOTH directions
 * must hold — a coordinator token cannot reach the dump, and a system token
 * cannot reach the org-scoped PII routes. Each 403 case pins its
 * `fields.reason` too, not just the status: several fixtures are 403 for
 * different reasons (wrong azp vs. wrong username vs. no aggregator_id), and
 * asserting status alone can't tell those apart or prove which gate fired.
 *
 * @module apps/api/campaign/__tests__/auth.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requireCampaignAuth, requireCampaignSystemAuth } from '../auth.js';
import { _setAccessTokenVerifier, _resetJwks } from '../../services/auth/access-token.js';

/** Builds a minimal request carrying the given bearer token value. */
function req(token?: string): FastifyRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as FastifyRequest;
}

const SYSTEM_CLAIMS = {
  sub: 'sa-uuid',
  azp: 'campaign-manager',
  preferred_username: 'service-account-campaign-manager',
};

const COORDINATOR_CLAIMS = {
  sub: 'human-uuid',
  azp: 'campaign-manager',
  preferred_username: 'coordinator@org.example',
  aggregator_id: 'agg-1',
  signalstack_org_id: 'org_5d3b7fa4',
  email: 'coordinator@org.example',
};

/**
 * A service account that has been misprovisioned with org attributes — the
 * state the local realm was found in. It must still be rejected by the
 * org-scoped gate, which is exactly what the absence of `aggregator_id`
 * cannot guarantee.
 */
const MISPROVISIONED_SYSTEM_CLAIMS = {
  ...SYSTEM_CLAIMS,
  aggregator_id: 'agg-1',
  signalstack_org_id: 'org_5d3b7fa4',
};

const PORTAL_SERVICE_CLAIMS = {
  sub: 'bff-uuid',
  azp: 'aggregator-bff',
  preferred_username: 'service-account-aggregator-bff',
};

/**
 * A campaign-manager-azp token with no `preferred_username` claim at all —
 * the case `campaignDumpServiceAccount()`'s non-empty fallback exists to
 * protect against (an empty expected value would otherwise match this).
 */
const NO_USERNAME_CLAIMS = {
  sub: 'no-username-uuid',
  azp: 'campaign-manager',
};

describe('campaign auth', () => {
  beforeEach(() => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setAccessTokenVerifier(async (token) => {
      switch (token) {
        case 'system':
          return SYSTEM_CLAIMS;
        case 'coordinator':
          return COORDINATOR_CLAIMS;
        case 'misprovisioned':
          return MISPROVISIONED_SYSTEM_CLAIMS;
        case 'portal':
          return PORTAL_SERVICE_CLAIMS;
        case 'no-username':
          return NO_USERNAME_CLAIMS;
        default:
          throw new Error('invalid token');
      }
    });
  });

  afterEach(() => {
    _setAccessTokenVerifier(null);
    delete process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT;
  });

  describe('requireCampaignSystemAuth', () => {
    it('accepts the campaign-manager service-account token', async () => {
      const ctx = await requireCampaignSystemAuth(req('system'));
      expect(ctx).toEqual({
        subject: 'sa-uuid',
        azp: 'campaign-manager',
        username: 'service-account-campaign-manager',
      });
    });

    it('rejects a coordinator token on the same client with 403 — wrong username', async () => {
      await expect(requireCampaignSystemAuth(req('coordinator'))).rejects.toMatchObject({
        status: 403,
        fields: { reason: 'NOT_SYSTEM_CLIENT' },
      });
    });

    it('rejects a portal/BFF service token with 403 — wrong azp', async () => {
      await expect(requireCampaignSystemAuth(req('portal'))).rejects.toMatchObject({
        status: 403,
        fields: { reason: 'AZP_NOT_ALLOWED' },
      });
    });

    it('rejects a missing token with 401', async () => {
      await expect(requireCampaignSystemAuth(req())).rejects.toMatchObject({
        status: 401,
      });
    });

    it('rejects an unverifiable token with 401', async () => {
      await expect(requireCampaignSystemAuth(req('garbage'))).rejects.toMatchObject({
        status: 401,
      });
    });

    it('rejects a token with no preferred_username claim at all', async () => {
      await expect(requireCampaignSystemAuth(req('no-username'))).rejects.toMatchObject({
        status: 403,
        fields: { reason: 'NOT_SYSTEM_CLIENT' },
      });
    });

    it('accepts a service account even when it carries stray org attributes', async () => {
      const ctx = await requireCampaignSystemAuth(req('misprovisioned'));
      expect(ctx.username).toBe('service-account-campaign-manager');
    });

    it('does not disable the gate when the expected username is empty', async () => {
      process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = '';
      await expect(requireCampaignSystemAuth(req('coordinator'))).rejects.toMatchObject({
        status: 403,
        fields: { reason: 'NOT_SYSTEM_CLIENT' },
      });
      const ctx = await requireCampaignSystemAuth(req('system'));
      expect(ctx.username).toBe('service-account-campaign-manager');
    });
  });

  describe('requireCampaignAuth — reverse direction', () => {
    it('accepts a coordinator token', async () => {
      const ctx = await requireCampaignAuth(req('coordinator'));
      expect(ctx.aggregatorId).toBe('agg-1');
      expect(ctx.signalstackOrgId).toBe('org_5d3b7fa4');
    });

    it('rejects the system token with 403 — the pre-existing missing-aggregator_id path, since a correctly-provisioned service account never reaches the new guard', async () => {
      await expect(requireCampaignAuth(req('system'))).rejects.toMatchObject({
        status: 403,
        fields: { reason: 'MISSING_AGGREGATOR_ID' },
      });
    });

    it('rejects a misprovisioned service account with 403 even though it has an org id — the new reverse-direction guard', async () => {
      await expect(requireCampaignAuth(req('misprovisioned'))).rejects.toMatchObject({
        status: 403,
        fields: { reason: 'SYSTEM_TOKEN_NOT_PERMITTED' },
      });
    });
  });
});
