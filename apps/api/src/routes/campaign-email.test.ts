// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the support.test.ts convention.
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

// The route only enqueues; mock the queue so no real Redis is touched.
const { enqueueCampaignEmailMock } = vi.hoisted(() => ({ enqueueCampaignEmailMock: vi.fn() }));
vi.mock('../services/campaign-email-queue/index.js', () => ({
  enqueueCampaignEmail: enqueueCampaignEmailMock,
}));

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('POST /v1/campaign/email', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    enqueueCampaignEmailMock.mockReset().mockResolvedValue(undefined);
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
  });

  const body = (over: Record<string, unknown> = {}) => ({
    item_ids: [VALID_UUID],
    subject: 'Hi {{first_name}}',
    body_markdown: 'Hello {{name}}, an **update**.',
    ...over,
  });

  it('returns 202 { status: "queued" } and enqueues the job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body({ reply_to: 'campaign@org.example', purpose: 'audit' }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('queued');
    expect(res.json().requested).toBe(1);
    expect(enqueueCampaignEmailMock).toHaveBeenCalledTimes(1);
    expect(enqueueCampaignEmailMock.mock.calls[0]![0]).toMatchObject({
      orgId: 'org_5d3b7fa4-x',
      itemIds: [VALID_UUID],
      subject: 'Hi {{first_name}}',
      bodyMarkdown: 'Hello {{name}}, an **update**.',
      replyTo: 'campaign@org.example',
      purpose: 'audit',
    });
  });

  it('accepts a body with no placeholders (plain broadcast)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body({ subject: 'Plain subject', body_markdown: 'Plain body, no tokens.' }),
    });
    expect(res.statusCode).toBe(202);
  });

  it('returns 400 UNKNOWN_PLACEHOLDER for an unsupported token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body({ body_markdown: 'Hi {{city}}' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_PLACEHOLDER');
    expect(res.json().error.fields.unknown).toEqual(['city']);
    expect(enqueueCampaignEmailMock).not.toHaveBeenCalled();
  });

  it('returns 401 when no Authorization header is sent', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/campaign/email', payload: body() });
    expect(res.statusCode).toBe(401);
    expect(enqueueCampaignEmailMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the token azp is not an allowed campaign client', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return {
          sub: 'u1',
          aggregator_id: 'agg-1',
          signalstack_org_id: 'org',
          azp: 'aggregator-portal',
        };
      }
      throw new Error('invalid');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body(),
    });
    expect(res.statusCode).toBe(401);
    expect(enqueueCampaignEmailMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the token has no signalstack_org_id claim', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') return { sub: 'u1', aggregator_id: 'agg-1', azp: 'campaign-manager' };
      throw new Error('invalid');
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('returns 400 for a non-uuid item id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body({ item_ids: ['not-a-uuid'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an empty item_ids array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body({ item_ids: [] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when item_ids exceeds the configured max', async () => {
    const tooMany = Array.from({ length: 201 }, () => VALID_UUID);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body({ item_ids: tooMany }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when subject or body is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID], subject: 'only subject' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 EMAIL_ENQUEUE_FAILED when the job cannot be queued', async () => {
    enqueueCampaignEmailMock.mockRejectedValueOnce(new Error('redis unavailable'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/email',
      headers: { authorization: 'Bearer good' },
      payload: body(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EMAIL_ENQUEUE_FAILED');
  });
});
