/**
 * Tests for GET /v1/campaign/dump — the whole-network non-PII dump download
 * (#692). Covers the auth matrix in both directions (including the audit-log
 * line each denial emits), the all-three-or-nothing rule (no partial `files`
 * list AND no URL minted before every key is confirmed present), the two 503
 * branches (each with its own `sub_operation` in the log), non-default TTL
 * propagation with an earliest-of-three `expires_at`, and the invariant that a
 * returned URL is exactly the value the signer issued — never constructed or
 * decorated by the route.
 *
 * @module apps/api/routes/campaign-dump.test
 */
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';
process.env.CAMPAIGN_DUMP_INSTANCE_ID = 'blue_dot_up';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
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
    vi.restoreAllMocks();
  });

  /** Issues the request with the given bearer token, or none. */
  function get(token?: string) {
    return app.inject({
      method: 'GET',
      url: '/v1/campaign/dump',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }

  it('returns all three files with pre-signed URLs for the system token, and logs the grant', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
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

    // The audit line is this whole-network, un-org-scoped route's only trail:
    // assert it actually carries the identity and the objects served, not
    // just that *some* info line fired.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'campaignDump.serve',
        status: 'success',
        subject: 'sa-uuid',
        files: [
          { key: KEYS.user, last_modified: '2026-08-26T00:30:58.000Z' },
          { key: KEYS.items, last_modified: '2026-08-26T00:31:04.000Z' },
          { key: KEYS.item_actions, last_modified: '2026-08-26T00:31:12.000Z' },
        ],
      }),
      expect.any(String),
    );
  });

  it('rejects a coordinator token with 403 and logs the denial with the correlating subject and request id', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const res = await get('coordinator');
    expect(res.statusCode).toBe(403);
    // The identity check is this route's only control, so the denial line
    // must carry the same correlators the success line does: `subject` (the
    // token verified — it just isn't the system account) and `request_id`,
    // so a denied call is traceable in the logs exactly like a served one.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'campaignDump.serve',
        status: 'failure',
        code: 'FORBIDDEN',
        reason: 'NOT_SYSTEM_CLIENT',
        subject: 'human-uuid',
        request_id: expect.any(String),
      }),
      expect.any(String),
    );
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
    'returns 404 DUMP_NOT_AVAILABLE and no partial file list when %s is missing, minting no URL at all',
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
      // Pins the ordering the all-three-or-none rule rests on: a route that
      // signed first and checked `missing` after would still pass every
      // assertion above while three live download URLs exist for a partial
      // snapshot.
      expect(signDownloadUrlMock).not.toHaveBeenCalled();
    },
  );

  it('returns 404 DUMP_NOT_AVAILABLE listing every key when none of the objects exist yet, and logs the denial with subject and request id', async () => {
    // The likeliest real 404 state: a fresh environment where the
    // signals-s3-export cron has never run, so all three keys are absent at
    // once — not the single-key case the `it.each` above exercises.
    const warnSpy = vi.spyOn(logger, 'warn');
    headObjectMock.mockResolvedValue(null);
    const res = await get('system');
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('DUMP_NOT_AVAILABLE');
    expect(body.error.fields.missing).toEqual([KEYS.user, KEYS.items, KEYS.item_actions]);
    expect(body.files).toBeUndefined();
    expect(signDownloadUrlMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'campaignDump.serve',
        status: 'failure',
        reason: 'objects_missing',
        subject: 'sa-uuid',
        request_id: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it('returns 503 DUMP_NOT_CONFIGURED when the instance id is unset, and logs the denial', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const previous = process.env.CAMPAIGN_DUMP_INSTANCE_ID;
    delete process.env.CAMPAIGN_DUMP_INSTANCE_ID;
    try {
      const res = await get('system');
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('DUMP_NOT_CONFIGURED');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'campaignDump.serve',
          status: 'failure',
          code: 'DUMP_NOT_CONFIGURED',
          reason: 'CAMPAIGN_DUMP_INSTANCE_ID_UNSET',
          subject: 'sa-uuid',
          request_id: expect.any(String),
        }),
        expect.any(String),
      );
    } finally {
      if (previous !== undefined) process.env.CAMPAIGN_DUMP_INSTANCE_ID = previous;
    }
  });

  it('returns 503 DUMP_STORAGE_UNAVAILABLE with no raw S3 message, and logs it as a HEAD failure', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    headObjectMock.mockRejectedValue(new Error('connection reset'));
    const res = await get('system');
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe('DUMP_STORAGE_UNAVAILABLE');
    // The error split matters: the client sees the catalogue's generic
    // detail, never the raw SDK message — that only reaches the log.
    expect(body.error.detail).not.toContain('connection reset');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'campaignDump.serve',
        status: 'failure',
        sub_operation: 'headObject',
        error: 'connection reset',
        subject: 'sa-uuid',
        request_id: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it('returns 503 DUMP_STORAGE_UNAVAILABLE with no raw S3 message, and logs it as a presign failure', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    signDownloadUrlMock.mockRejectedValue(new Error('presign failed'));
    const res = await get('system');
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe('DUMP_STORAGE_UNAVAILABLE');
    expect(body.error.detail).not.toContain('presign failed');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'campaignDump.serve',
        status: 'failure',
        sub_operation: 'signDownloadUrl',
        error: 'presign failed',
        subject: 'sa-uuid',
        request_id: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it('presigns every key with the configured TTL', async () => {
    // `config` is a plain object (not `Object.freeze`d) read directly by the
    // route at request time, so mutating it here is the reliable way to prove
    // wiring: module-level `process.env.CAMPAIGN_DUMP_URL_TTL_SECONDS = ...`
    // set before this file's imports does NOT reach the frozen `config`
    // snapshot — `../app.js`'s (and so `../config.js`'s) module evaluation
    // completes before this file's own top-level statements run, same as any
    // ES module graph. A value equal to the schema default (600) would also
    // pass this assertion whether the route were wired, hardcoded, or broken,
    // so a non-default value is required to make the test able to fail.
    const previousTtl = config.CAMPAIGN_DUMP_URL_TTL_SECONDS;
    config.CAMPAIGN_DUMP_URL_TTL_SECONDS = 137;
    try {
      const res = await get('system');
      expect(res.statusCode).toBe(200);
      expect(signDownloadUrlMock).toHaveBeenCalledTimes(3);
      for (const call of signDownloadUrlMock.mock.calls) {
        expect(call[1]).toMatchObject({ ttlSeconds: 137 });
      }
    } finally {
      config.CAMPAIGN_DUMP_URL_TTL_SECONDS = previousTtl;
    }
  });

  it('reports the EARLIEST of the three presigned expiries, not an arbitrary one', async () => {
    // The three presigns run concurrently and can genuinely disagree by a few
    // ms; the route must report the earliest so `expires_at` never outlives
    // one of the URLs it describes. Distinguishes `Math.min` from "whichever
    // key resolved first" or "the first key in `DUMP_TABLES` order" — every
    // mocked expiry here differs, and the middle one (`items`) is earliest.
    const expiries: Record<string, string> = {
      [KEYS.user]: '2026-08-26T00:50:00.000Z',
      [KEYS.items]: '2026-08-26T00:40:00.000Z',
      [KEYS.item_actions]: '2026-08-26T00:45:00.000Z',
    };
    signDownloadUrlMock.mockImplementation(async (key: string) => ({
      url: `https://s3.public.example/${key}?X-Amz-Signature=abc`,
      key,
      expiresAt: expiries[key],
    }));
    const res = await get('system');
    expect(res.statusCode).toBe(200);
    expect(res.json().expires_at).toBe(expiries[KEYS.items]);
  });

  it('returns exactly the URL the signer issued, per key — the route never constructs or decorates one', async () => {
    const res = await get('system');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const [table, key] of Object.entries(KEYS)) {
      const file = body.files.find((f: { table: string }) => f.table === table);
      expect(file.url).toBe(`https://s3.public.example/${key}?X-Amz-Signature=abc`);
    }
  });
});
