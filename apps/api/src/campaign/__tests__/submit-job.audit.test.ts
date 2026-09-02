// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the campaign-export.test.ts convention.
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../../services/auth/access-token.js';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../../services/aggregator-store/index.js';
import {
  InMemoryCampaignJobStore,
  _setCampaignJobStore,
} from '../../services/campaign-job-store/index.js';
import { _setCampaignAuditWriter } from '../../services/campaign-audit/index.js';
import { CampaignAuditWriterFake } from '@aggregator-dpg/campaign-audit/testing';

// The route only persists + enqueues; mock the queue so no real Redis is
// touched.
const { enqueueCampaignProcessMock } = vi.hoisted(() => ({
  enqueueCampaignProcessMock: vi.fn(),
}));
vi.mock('../../services/campaign-process-queue/index.js', () => ({
  enqueueCampaignProcess: enqueueCampaignProcessMock,
}));

// The rate limiter is mocked so tests never open a Redis socket.
const { consumeMock } = vi.hoisted(() => ({ consumeMock: vi.fn() }));
vi.mock('../../services/rate-limiter/index.js', () => ({
  consume: consumeMock,
}));

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('campaign submit — requested audit row (#617)', () => {
  let app: FastifyInstance;
  let auditFake: CampaignAuditWriterFake;

  beforeEach(async () => {
    enqueueCampaignProcessMock.mockReset().mockResolvedValue(undefined);
    consumeMock.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });

    _setCampaignJobStore(new InMemoryCampaignJobStore());

    const aggStore = new AggregatorStoreFake();
    aggStore.seed([
      buildAggregator({ id: 'agg-1', contactEmail: 'aggregator@org.example', status: 'active' }),
    ]);
    _setAggregatorStore(aggStore);

    auditFake = new CampaignAuditWriterFake();
    _setCampaignAuditWriter(auditFake);

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
    _setCampaignJobStore(null);
    _setCampaignAuditWriter(null);
  });

  function post(payload: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good', ...headers },
      payload: payload as object,
    });
  }

  it('writes one requested audit row with the actor and no outcome', async () => {
    const res = await post({
      item_ids: [VALID_UUID],
      metadata: [{ key: 'purpose', value: 'audit' }],
      content: {},
    });
    expect(res.statusCode).toBe(202);
    const rows = auditFake.rows.filter((r) => r.kind === 'requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.correlationId).toBe(res.json().job_id);
    expect(rows[0]!.actorOrgId).toBe('org_5d3b7fa4-x');
    expect(rows[0]!.purpose).toBe('audit');
    expect(rows[0]!.piiFields).toEqual(['name', 'email', 'phone']);
    expect('outcome' in rows[0]!).toBe(false);
  });

  it('still returns 202 when the audit write fails', async () => {
    auditFake.failWith = new Error('audit down');
    const res = await post({ item_ids: [VALID_UUID], content: {} });
    // Best effort: the campaign is already committed and enqueued by this point.
    expect(res.statusCode).toBe(202);
  });

  it('does not write an audit row for a status poll', async () => {
    const created = await post({ item_ids: [VALID_UUID], content: {} });
    auditFake.reset();
    await app.inject({
      method: 'GET',
      url: `/v1/campaign/export/${created.json().job_id}`,
      headers: { authorization: 'Bearer good' },
    });
    expect(auditFake.rows).toHaveLength(0);
  });
});
