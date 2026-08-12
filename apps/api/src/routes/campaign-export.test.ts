// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the support.test.ts convention.
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../services/aggregator-store/index.js';

// The route only enqueues; mock the queue so no real Redis is touched and we
// can assert the payload and simulate an enqueue failure.
const { enqueueCampaignExportMock } = vi.hoisted(() => ({
  enqueueCampaignExportMock: vi.fn(),
}));
vi.mock('../services/campaign-export-queue/index.js', () => ({
  enqueueCampaignExport: enqueueCampaignExportMock,
}));

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('POST /v1/campaign/export', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    enqueueCampaignExportMock.mockReset().mockResolvedValue(undefined);

    // The requesting aggregator (token aggregator_id=agg-1) resolves to this
    // record; its contact_email is the export recipient.
    const store = new AggregatorStoreFake();
    store.seed([
      buildAggregator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'active' }),
    ]);
    _setAggregatorStore(store);

    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-1',
          signalstack_org_id: 'org_5d3b7fa4-x',
          azp: 'campaign-manager',
        };
      }
      throw new Error('invalid');
    });

    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setAggregatorStore(null);
  });

  it('returns 202 { status: "queued" } and enqueues the job for a valid request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID], purpose: 'audit' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('queued');
    expect(res.json().message).toMatch(/requesting aggregator/i);
    expect(enqueueCampaignExportMock).toHaveBeenCalledTimes(1);
    const payload = enqueueCampaignExportMock.mock.calls[0]![0];
    expect(payload).toMatchObject({
      orgId: 'org_5d3b7fa4-x',
      itemIds: [VALID_UUID],
      purpose: 'audit',
      recipientEmail: 'aggregator@org.example',
    });
  });

  it("uses the requesting user's token email as the recipient, over the DB contact_email", async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-1',
          signalstack_org_id: 'org_5d3b7fa4-x',
          azp: 'campaign-manager',
          email: 'user@sanketika.in',
        };
      }
      throw new Error('invalid');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(202);
    // token email wins over the seeded aggregator contact_email
    expect(enqueueCampaignExportMock.mock.calls[0]![0]).toMatchObject({
      recipientEmail: 'user@sanketika.in',
    });
  });

  it('returns 401 when the token azp is not an allowed campaign-export client', async () => {
    // A portal/api/bff token (the global allow-list) must NOT be accepted here —
    // the route opts into CAMPAIGN_MANAGER_ALLOWED_AZP (campaign-manager) only.
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-1',
          signalstack_org_id: 'org_5d3b7fa4-x',
          azp: 'aggregator-portal',
        };
      }
      throw new Error('invalid');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(enqueueCampaignExportMock).not.toHaveBeenCalled();
  });

  it('does not disable the azp gate when CAMPAIGN_MANAGER_ALLOWED_AZP is pathological (",")', async () => {
    const prev = process.env.CAMPAIGN_MANAGER_ALLOWED_AZP;
    process.env.CAMPAIGN_MANAGER_ALLOWED_AZP = ',';
    try {
      // "," parses to an empty allow-list; the helper must fall back to the
      // default rather than un-gating the route. A non-campaign-manager token
      // must STILL be rejected.
      _setAccessTokenVerifier(async (token) => {
        if (token === 'good') {
          return {
            sub: 'u1',
            aggregator_id: 'agg-1',
            signalstack_org_id: 'org_5d3b7fa4-x',
            azp: 'aggregator-portal',
          };
        }
        throw new Error('invalid');
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/campaign/export',
        headers: { authorization: 'Bearer good' },
        payload: { item_ids: [VALID_UUID] },
      });
      expect(res.statusCode).toBe(401);
      expect(enqueueCampaignExportMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CAMPAIGN_MANAGER_ALLOWED_AZP;
      else process.env.CAMPAIGN_MANAGER_ALLOWED_AZP = prev;
    }
  });

  it('returns 403 when the requesting aggregator is not active', async () => {
    const store = new AggregatorStoreFake();
    store.seed([
      buildAggregator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'inactive' }),
    ]);
    _setAggregatorStore(store);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(enqueueCampaignExportMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the requesting aggregator is not found (inactive gate)', async () => {
    // Empty store: findById(agg-1) resolves to null → not active.
    _setAggregatorStore(new AggregatorStoreFake());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(res.json().error.fields.reason).toBe('AGGREGATOR_INACTIVE');
    expect(enqueueCampaignExportMock).not.toHaveBeenCalled();
  });

  it('returns 403 RECIPIENT_UNRESOLVED when neither the token nor the aggregator has an email', async () => {
    // Active aggregator but no contact_email, and the token carries no email claim.
    const store = new AggregatorStoreFake();
    store.seed([buildAggregator({ id: 'agg-1', contactEmail: '', status: 'active' })]);
    _setAggregatorStore(store);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.fields.reason).toBe('RECIPIENT_UNRESOLVED');
    expect(enqueueCampaignExportMock).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHORIZED when no Authorization header is sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(enqueueCampaignExportMock).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHORIZED for an invalid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer bad' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 FORBIDDEN when the token has no signalstack_org_id claim', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return { sub: 'u1', aggregator_id: 'agg-1', azp: 'campaign-manager' };
      }
      throw new Error('invalid');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(enqueueCampaignExportMock).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN when the token has no aggregator_id claim (MISSING_AGGREGATOR_ID)', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return { sub: 'u1', azp: 'campaign-manager' };
      }
      throw new Error('invalid');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for an invalid body (non-uuid item id)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: ['not-a-uuid'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an empty item_ids array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when item_ids exceeds the configured max', async () => {
    // .max() only checks array length — duplicate ids are fine for this check.
    const tooMany = Array.from({ length: 501 }, () => VALID_UUID);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: tooMany },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 EXPORT_ENQUEUE_FAILED when the job cannot be queued', async () => {
    enqueueCampaignExportMock.mockRejectedValueOnce(new Error('redis unavailable'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EXPORT_ENQUEUE_FAILED');
  });
});
