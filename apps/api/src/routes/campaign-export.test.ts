// Env must be set before any import that pulls in `config` (parsed once at
// first import). Mirrors the support.test.ts convention.
process.env.EXPORT_NETWORK_ADMIN_EMAIL = 'admin@network.org';
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc-org';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { _setSignalStackWriter } from '../services/signalstack.js';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('POST /v1/campaign/export', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.EXPORT_NETWORK_ADMIN_EMAIL = 'admin@network.org';
    // Inject an empty fake writer: decrypt resolves to nothing, so the
    // fire-and-forget job hits the empty-guard and performs no S3/mail I/O —
    // keeping these tests deterministic on the synchronous contract.
    _setSignalStackWriter(new SignalStackWriterFake());
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setSignalStackWriter(null);
  });

  it('returns 202 { status: "queued" } for a valid, configured request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { 'x-org-id': 'org-1' },
      payload: { item_ids: [VALID_UUID], purpose: 'audit' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued' });
  });

  it('returns 401 MISSING_ORG_ID when x-org-id is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_ORG_ID');
  });

  it('returns 400 for an invalid body (non-uuid item id)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { 'x-org-id': 'org-1' },
      payload: { item_ids: ['not-a-uuid'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an empty item_ids array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { 'x-org-id': 'org-1' },
      payload: { item_ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 EXPORT_NOT_CONFIGURED when the network admin email is unset', async () => {
    delete process.env.EXPORT_NETWORK_ADMIN_EMAIL;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaign/export',
      headers: { 'x-org-id': 'org-1' },
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
      headers: { 'x-org-id': 'org-1' },
      payload: { item_ids: [VALID_UUID] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EXPORT_NOT_CONFIGURED');
  });
});
