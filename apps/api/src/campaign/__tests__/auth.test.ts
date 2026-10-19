/**
 * Tests for the campaign auth helper — the org-scoped coordinator gate
 * (`requireCampaignAuth`), including its rejection of the campaign-manager
 * system (client_credentials) token. Each 403 case pins its `fields.reason`
 * too, not just the status: fixtures are 403 for different reasons (wrong
 * azp vs. no aggregator_id vs. system token), and asserting status alone
 * can't tell those apart or prove which check fired.
 *
 * @module apps/api/campaign/__tests__/auth.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requireCampaignAuth } from '../auth.js';
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
        default:
          throw new Error('invalid token');
      }
    });
  });

  afterEach(() => {
    _setAccessTokenVerifier(null);
  });

  describe('requireCampaignAuth', () => {
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
