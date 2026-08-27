/**
 * Tests for the QR download surface on registration links.
 *
 * Two behaviours are pinned here:
 *
 *   1. `GET /v1/links/:id/qr` mints a short-lived pre-signed URL per call,
 *      enforces ownership, refuses non-live links, and refuses to sign a
 *      `qr_object_key` that is not the canonical key for this caller + link.
 *   2. Read and list responses expose the stable `qr_download_path` and do NOT
 *      presign. That is the regression guard for both the per-row signing cost
 *      on the list endpoint and for leaking bearer-credential URLs into
 *      collection responses.
 *
 * Object storage is mocked at the module boundary (per testing.md §1 — a
 * third-party adapter may be stubbed) so no S3/MinIO call is ever made.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type ListRegistrationLinksOptions,
  type ListRegistrationLinksResult,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import { _setDbClients } from '../db/client.js';

const { putObjectMock, signQrDownloadUrlMock } = vi.hoisted(() => ({
  putObjectMock: vi.fn(),
  signQrDownloadUrlMock: vi.fn(),
}));

vi.mock('../services/object-storage/index.js', () => ({
  putObject: putObjectMock,
  signQrDownloadUrl: signQrDownloadUrlMock,
}));

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_AGG_ID = '99999999-9999-4999-8999-999999999999';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const USER_ID = 'kc-user-1';
const AUTH_TOKEN = 'agg-a-token';
const LINK_ID = 'link-1';

/** Canonical QR key for the seeded link — what the route must be willing to sign. */
const CANONICAL_QR_KEY = `qr/${AGG_ID}/${LINK_ID}.png`;

function buildLink(overrides: Partial<RegistrationLink> = {}): RegistrationLink {
  const now = new Date('2026-08-24T00:00:00.000Z');
  return {
    id: LINK_ID,
    aggregatorId: AGG_ID,
    slug: 'walk-in',
    domain: 'seeker',
    context: {},
    registrationMode: 'form',
    qrObjectKey: CANONICAL_QR_KEY,
    status: 'live',
    expiresAt: null,
    createdBy: USER_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Seeded store honouring the real aggregator-scoping contract of findById. */
class SeededStore extends RegistrationLinksStoreBase {
  constructor(private readonly rows: RegistrationLink[]) {
    super();
  }
  async findById(id: string, aggregatorId: string): Promise<StoreResult<RegistrationLink | null>> {
    const row = this.rows.find((r) => r.id === id && r.aggregatorId === aggregatorId);
    return { ok: true, value: row ?? null };
  }
  async list(
    aggregatorId: string,
    _options: ListRegistrationLinksOptions,
  ): Promise<StoreResult<ListRegistrationLinksResult>> {
    const rows = this.rows.filter((r) => r.aggregatorId === aggregatorId);
    return { ok: true, value: { rows, total: rows.length } };
  }
  async create(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findByOrgAndSlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async updateQrKey(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async updateDraft(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async updateStatus(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
}

function buildMetricsStubDb(): unknown {
  const emptyChain = {
    select: () => emptyChain,
    from: () => emptyChain,
    where: () => emptyChain,
    groupBy: () => Promise.resolve([] as unknown[]),
  };
  return emptyChain;
}

async function bootApp(rows: RegistrationLink[]): Promise<FastifyInstance> {
  _resetJwks();
  process.env.KEYCLOAK_URL = 'http://kc.local';
  process.env.KEYCLOAK_REALM = 'bluedots';
  _setNetworkConfig(buildBlueDotConfig());
  _setAccessTokenVerifier(async (token) => {
    if (token !== AUTH_TOKEN) throw new Error('invalid');
    return {
      sub: USER_ID,
      email: 'a@x.com',
      aggregator_id: AGG_ID,
      aggregator_type: 'seeker',
      decision_made: 'approved',
    };
  });
  const aggStore = new AggregatorStoreFake();
  aggStore.seed([
    buildAggregator({
      id: AGG_ID,
      orgSlug: ORG_SLUG,
      name: 'Acme',
      status: 'active',
      signalstackOrgId: ORG_ID,
    }),
  ]);
  _setAggregatorStore(aggStore);
  _setRegistrationLinksStore(new SeededStore(rows));
  _setDbClients(null, buildMetricsStubDb() as never);
  return buildApp();
}

const AUTH = { authorization: `Bearer ${AUTH_TOKEN}` };

describe('GET /v1/links/:id/qr', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    signQrDownloadUrlMock.mockReset();
    putObjectMock.mockReset();
    signQrDownloadUrlMock.mockResolvedValue({
      url: 'https://s3.example.invalid/qr.png?X-Amz-Signature=abc',
      key: CANONICAL_QR_KEY,
      expiresAt: '2026-08-24T00:10:00.000Z',
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    _setAccessTokenVerifier(null);
    _setAggregatorStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
  });

  it('401s without a token, and does not sign', async () => {
    app = await bootApp([buildLink()]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr` });
    expect(res.statusCode).toBe(401);
    expect(signQrDownloadUrlMock).not.toHaveBeenCalled();
  });

  it('mints a fresh pre-signed URL for a live link the caller owns', async () => {
    app = await bootApp([buildLink()]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { link_id: string; url: string; expires_at: string };
    expect(body.link_id).toBe(LINK_ID);
    expect(body.url).toContain('X-Amz-Signature');
    expect(body.expires_at).toBe('2026-08-24T00:10:00.000Z');
    expect(signQrDownloadUrlMock).toHaveBeenCalledWith(CANONICAL_QR_KEY);
  });

  // The URL inside the payload expires. A cached response would hand a client a
  // dead URL and reintroduce the staleness this endpoint exists to remove.
  it('forbids caching the response', async () => {
    app = await bootApp([buildLink()]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr`, headers: AUTH });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('mints a new URL on every call rather than reusing one', async () => {
    app = await bootApp([buildLink()]);
    await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr`, headers: AUTH });
    await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr`, headers: AUTH });
    expect(signQrDownloadUrlMock).toHaveBeenCalledTimes(2);
  });

  it("403s for another aggregator's link, without signing", async () => {
    app = await bootApp([buildLink({ aggregatorId: OTHER_AGG_ID })]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr`, headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect(signQrDownloadUrlMock).not.toHaveBeenCalled();
  });

  it.each(['draft', 'retired'] as const)('404s for a %s link, without signing', async (status) => {
    app = await bootApp([buildLink({ status })]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr`, headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(signQrDownloadUrlMock).not.toHaveBeenCalled();
  });

  it('404s when the link has no QR object yet, without signing', async () => {
    app = await bootApp([buildLink({ qrObjectKey: null })]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr`, headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(signQrDownloadUrlMock).not.toHaveBeenCalled();
  });

  // Signing allow-list. If any of these ever 200s, the endpoint has become a
  // pre-signed read of an arbitrary object in the bucket.
  it.each([
    ['another tenant prefix', `qr/${OTHER_AGG_ID}/${LINK_ID}.png`],
    ['another link id', `qr/${AGG_ID}/some-other-link.png`],
    ['a different object class', `uploads/raw/${AGG_ID}/an-upload.csv`],
    ['an arbitrary path', 'some/other/object.png'],
  ])('404s when the stored key is %s, without signing', async (_label, storedKey) => {
    app = await bootApp([buildLink({ qrObjectKey: storedKey })]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}/qr`, headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(signQrDownloadUrlMock).not.toHaveBeenCalled();
  });
});

describe('QR exposure on read and list responses', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    signQrDownloadUrlMock.mockReset();
    putObjectMock.mockReset();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    _setAccessTokenVerifier(null);
    _setAggregatorStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
  });

  it('exposes a stable download path on a single-link read', async () => {
    app = await bootApp([buildLink()]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { qr_download_path: string | null; qr_url: string | null };
    expect(body.qr_download_path).toBe(`/v1/links/${LINK_ID}/qr`);
    expect(body.qr_url).toBeNull();
  });

  it.each(['draft', 'retired'] as const)(
    'exposes no download path for a %s link',
    async (status) => {
      app = await bootApp([buildLink({ status })]);
      const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}`, headers: AUTH });
      expect((res.json() as { qr_download_path: string | null }).qr_download_path).toBeNull();
    },
  );

  it('exposes no download path when the QR has not been generated', async () => {
    app = await bootApp([buildLink({ qrObjectKey: null })]);
    const res = await app.inject({ method: 'GET', url: `/v1/links/${LINK_ID}`, headers: AUTH });
    expect((res.json() as { qr_download_path: string | null }).qr_download_path).toBeNull();
  });

  // The performance regression guard: a list of N links used to cost N
  // signatures. It must now cost zero.
  it('signs nothing when listing links', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      buildLink({
        id: `link-${i}`,
        slug: `walk-in-${i}`,
        qrObjectKey: `qr/${AGG_ID}/link-${i}.png`,
      }),
    );
    app = await bootApp(rows);
    const res = await app.inject({ method: 'GET', url: '/v1/links', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(signQrDownloadUrlMock).not.toHaveBeenCalled();
  });

  // The exposure guard: no bearer-credential URL may appear anywhere in a
  // collection response, however the shape evolves.
  it('serialises no pre-signed URL anywhere in a list response', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      buildLink({
        id: `link-${i}`,
        slug: `walk-in-${i}`,
        qrObjectKey: `qr/${AGG_ID}/link-${i}.png`,
      }),
    );
    app = await bootApp(rows);
    const res = await app.inject({ method: 'GET', url: '/v1/links', headers: AUTH });
    expect(res.body).not.toContain('X-Amz-Signature');
    const body = res.json() as { items: Array<{ qr_download_path: string | null }> };
    expect(body.items).toHaveLength(3);
    for (const [i, item] of body.items.entries()) {
      expect(item.qr_download_path).toBe(`/v1/links/link-${i}/qr`);
    }
  });
});
