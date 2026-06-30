import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../services/aggregator-store/index.js';
import {
  AggregatorProfileStoreFake,
  _setAggregatorProfileStore,
} from '../services/aggregator-profile-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('POST /admin/v1/aggregator-registrations/cleanup-stale', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let profileStore: AggregatorProfileStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    aggregatorStore = new AggregatorStoreFake();
    profileStore = new AggregatorProfileStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    _setAggregatorStore(aggregatorStore);
    _setAggregatorProfileStore(profileStore);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setAccessTokenVerifier(async (token) => {
      if (token === SERVICE_BEARER) {
        return { sub: 'service-account-aggregator-bff', azp: 'aggregator-bff' };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setAggregatorProfileStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setAccessTokenVerifier(null);
  });

  it('prunes only stale pending registrations and their KC users', async () => {
    // Fresh pending — last touched now, well within the grace window → survives.
    const fresh = buildAggregator({
      id: '11111111-1111-1111-1111-111111111111',
      orgSlug: 'fresh-aaaa',
      contact: { name: 'Fresh', phone: '+919000000001', email: 'fresh@x.org' },
      contactPhone: '+919000000001',
      contactEmail: 'fresh@x.org',
      status: 'pending',
      updatedAt: new Date(),
    });
    // Stale pending — last touched in 2020, far past TTL + grace → pruned.
    const stale = buildAggregator({
      id: '22222222-2222-2222-2222-222222222222',
      orgSlug: 'stale-bbbb',
      contact: { name: 'Stale', phone: '+919000000002', email: 'stale@x.org' },
      contactPhone: '+919000000002',
      contactEmail: 'stale@x.org',
      status: 'pending',
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    });
    aggregatorStore.seed([fresh, stale]);
    await idp.createUser({ email: 'stale@x.org', enabled: false });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scanned: number; pruned: number; prunedIds: string[] };
    expect(body.pruned).toBe(1);
    expect(body.prunedIds).toContain(stale.id);
    expect(body.prunedIds).not.toContain(fresh.id);

    const goneKc = await idp.findByEmail('stale@x.org');
    if (goneKc.ok) expect(goneKc.value).toBeNull();

    const staleRow = await aggregatorStore.findById(stale.id);
    if (staleRow.ok) expect(staleRow.value).toBeNull();
    const freshRow = await aggregatorStore.findById(fresh.id);
    if (freshRow.ok) expect(freshRow.value).not.toBeNull();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns zero counts when nothing is stale', async () => {
    aggregatorStore.seed([
      buildAggregator({
        id: '33333333-3333-3333-3333-333333333333',
        orgSlug: 'recent-cccc',
        contact: { name: 'Recent', phone: '+919000000003', email: 'recent@x.org' },
        contactPhone: '+919000000003',
        contactEmail: 'recent@x.org',
        status: 'pending',
        updatedAt: new Date(),
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/v1/aggregator-registrations/cleanup-stale',
      headers: AUTH_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scanned: number; pruned: number };
    expect(body.scanned).toBe(1);
    expect(body.pruned).toBe(0);
  });
});
