// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the support.test.ts convention.
process.env.EXPORT_NETWORK_ADMIN_EMAIL = 'admin@network.org';
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('POST /v1/campaign/export', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.EXPORT_NETWORK_ADMIN_EMAIL = 'admin@network.org';
    // Inject an empty fake writer: decrypt resolves to nothing, so the
    // fire-and-forget job hits the empty-guard and performs no S3/mail I/O —
    // keeping these tests deterministic on the synchronous contract.
    _setSignalStackWriter(new SignalStackWriterFake());

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
    _setSignalStackWriter(null);
    _setAccessTokenVerifier(null);
  });

  it('returns 202 { status: "queued" } for a valid, configured request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID], purpose: 'audit' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('queued');
    expect(res.json().message).toMatch(/network administrator/i);
  });

  it('returns 401 UNAUTHORIZED when no Authorization header is sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
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
        return { sub: 'u1', aggregator_id: 'agg-1' };
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

  it('returns 403 FORBIDDEN when the token has no aggregator_id claim (MISSING_AGGREGATOR_ID)', async () => {
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good') {
        return { sub: 'u1' };
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

  it('returns 503 EXPORT_NOT_CONFIGURED when the network admin email is unset', async () => {
    delete process.env.EXPORT_NETWORK_ADMIN_EMAIL;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EXPORT_NOT_CONFIGURED');
  });

  it('returns 503 EXPORT_NOT_CONFIGURED when no signalstack writer is configured', async () => {
    _setSignalStackWriter(null);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { authorization: 'Bearer good' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EXPORT_NOT_CONFIGURED');
  });
});
