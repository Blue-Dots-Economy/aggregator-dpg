/**
 * Tests for GET /v1/campaign/dump — the whole-network non-PII dump download
 * (#692). Covers the auth matrix in both directions, the all-three-or-404 rule,
 * the two 503 branches, TTL propagation, and the invariant that the response
 * leaks no S3 credential.
 *
 * @module apps/api/routes/campaign-dump.test
 */
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';
process.env.CAMPAIGN_DUMP_INSTANCE_ID = 'blue_dot_up';
process.env.CAMPAIGN_DUMP_URL_TTL_SECONDS = '600';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

// S3 is mocked: these tests assert the route's contract, not the SDK.
//
// The factory MUST also export signBulkUploadUrl and signErrorsCsvDownloadUrl.
// vi.mock replaces the WHOLE module, and routes/bulk-uploads.ts imports those
// two by name — omit them and buildApp() dies on a missing named export, which
// surfaces as every test in this file failing for an unrelated reason.
const { headObjectMock, signDownloadUrlMock } = vi.hoisted(() => ({
  headObjectMock: vi.fn(),
  signDownloadUrlMock: vi.fn(),
}));
vi.mock('../services/object-storage/index.js', () => ({
  headObject: headObjectMock,
  signDownloadUrl: signDownloadUrlMock,
  signBulkUploadUrl: vi.fn(),
  signErrorsCsvDownloadUrl: vi.fn(),
}));

const KEYS = {
  user: 'blue_dot/blue_dot_up/user.ndjson.gz',
  items: 'blue_dot/blue_dot_up/items.ndjson.gz',
  item_actions: 'blue_dot/blue_dot_up/item_actions.ndjson.gz',
};

/** Makes every HEAD succeed with a distinct size and timestamp. */
function allObjectsPresent(): void {
  headObjectMock.mockImplementation(async (key: string) => {
    const sizes: Record<string, number> = {
      [KEYS.user]: 12345,
      [KEYS.items]: 23456,
      [KEYS.item_actions]: 34567,
    };
    const times: Record<string, string> = {
      [KEYS.user]: '2026-08-26T00:30:58.000Z',
      [KEYS.items]: '2026-08-26T00:31:04.000Z',
      [KEYS.item_actions]: '2026-08-26T00:31:12.000Z',
    };
    if (!(key in sizes)) return null;
    return { etag: 'e', contentLength: sizes[key]!, lastModified: new Date(times[key]!) };
  });
}

describe('GET /v1/campaign/dump', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    headObjectMock.mockReset();
    signDownloadUrlMock.mockReset().mockImplementation(async (key: string) => ({
      url: `https://s3.public.example/${key}?X-Amz-Signature=abc`,
      key,
      expiresAt: '2026-08-26T00:46:12.000Z',
    }));
    allObjectsPresent();

    _setNetworkConfig(buildBlueDotConfig());
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.CAMPAIGN_DUMP_INSTANCE_ID = 'blue_dot_up';
    _setAccessTokenVerifier(async (token) => {
      switch (token) {
        case 'system':
          return {
            sub: 'sa-uuid',
            azp: 'campaign-manager',
            preferred_username: 'service-account-campaign-manager',
          };
        case 'coordinator':
          return {
            sub: 'human-uuid',
            azp: 'campaign-manager',
            preferred_username: 'coordinator@org.example',
            aggregator_id: 'agg-1',
            signalstack_org_id: 'org_5d3b7fa4',
          };
        case 'portal':
          return {
            sub: 'bff-uuid',
            azp: 'aggregator-bff',
            preferred_username: 'service-account-aggregator-bff',
          };
        default:
          throw new Error('invalid token');
      }
    });

    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  /** Issues the request with the given bearer token, or none. */
  function get(token?: string) {
    return app.inject({
      method: 'GET',
      url: '/v1/campaign/dump',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }

  it('returns all three files with pre-signed URLs for the system token', async () => {
    const res = await get('system');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe('blue_dot');
    expect(body.instance).toBe('blue_dot_up');
    expect(body.files).toHaveLength(3);
    expect(body.files.map((f: { table: string }) => f.table)).toEqual([
      'user',
      'items',
      'item_actions',
    ]);
    expect(body.files[0]).toMatchObject({
      table: 'user',
      key: KEYS.user,
      size_bytes: 12345,
      last_modified: '2026-08-26T00:30:58.000Z',
    });
    for (const file of body.files) {
      expect(file.url).toContain('X-Amz-Signature');
    }
  });

  it('rejects a coordinator token with 403', async () => {
    const res = await get('coordinator');
    expect(res.statusCode).toBe(403);
  });

  it('rejects a portal/BFF service token with 403', async () => {
    const res = await get('portal');
    expect(res.statusCode).toBe(403);
  });

  it('rejects a request with no token with 401', async () => {
    const res = await get();
    expect(res.statusCode).toBe(401);
  });

  it.each(Object.entries(KEYS))(
    'returns 404 DUMP_NOT_AVAILABLE and no partial file list when %s is missing',
    async (_table, missingKey) => {
      allObjectsPresent();
      const previous = headObjectMock.getMockImplementation()!;
      headObjectMock.mockImplementation(async (key: string) =>
        key === missingKey ? null : previous(key),
      );
      const res = await get('system');
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe('DUMP_NOT_AVAILABLE');
      expect(body.error.fields.missing).toEqual([missingKey]);
      expect(body.files).toBeUndefined();
    },
  );

  it('returns 503 DUMP_NOT_CONFIGURED when the instance id is unset', async () => {
    delete process.env.CAMPAIGN_DUMP_INSTANCE_ID;
    const res = await get('system');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DUMP_NOT_CONFIGURED');
  });

  it('returns 503 DUMP_STORAGE_UNAVAILABLE when a HEAD throws', async () => {
    headObjectMock.mockRejectedValue(new Error('connection reset'));
    const res = await get('system');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DUMP_STORAGE_UNAVAILABLE');
  });

  it('returns 503 DUMP_STORAGE_UNAVAILABLE when presigning throws', async () => {
    signDownloadUrlMock.mockRejectedValue(new Error('presign failed'));
    const res = await get('system');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DUMP_STORAGE_UNAVAILABLE');
  });

  it('presigns every key with the configured TTL and reports one shared expiry', async () => {
    const res = await get('system');
    expect(res.statusCode).toBe(200);
    expect(signDownloadUrlMock).toHaveBeenCalledTimes(3);
    for (const call of signDownloadUrlMock.mock.calls) {
      expect(call[1]).toMatchObject({ ttlSeconds: 600 });
    }
    expect(res.json().expires_at).toBe('2026-08-26T00:46:12.000Z');
  });

  it('leaks no S3 credential in the response', async () => {
    process.env.S3_ACCESS_KEY_ID = 'AKIAEXAMPLEKEY';
    process.env.S3_SECRET_ACCESS_KEY = 'super-secret-value';
    const res = await get('system');
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('AKIAEXAMPLEKEY');
    expect(res.payload).not.toContain('super-secret-value');
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });
});
