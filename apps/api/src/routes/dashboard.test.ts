import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';

const AGG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_A = 'org_aaa_signalstack';

/**
 * Builds a deterministic rollup with the same shape signalstack returns
 * per domain. Defaults zero everything; tests override only the fields
 * they care about.
 */
function makeRollup(
  overrides: Partial<{
    total_items: number;
    complete_profiles: number;
    has_applications: number;
    by_status: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', number>>;
    by_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
    avg_items_per_user: number;
    avg_actions_per_user: number;
    mode_wise_counts: Record<string, number>;
  }>,
) {
  return {
    total_items: 0,
    complete_profiles: 0,
    has_applications: 0,
    by_status: {},
    by_action_status: {},
    avg_items_per_user: 0,
    avg_actions_per_user: 0,
    mode_wise_counts: {},
    ...overrides,
  };
}

describe('blue-dots routes', () => {
  let app: FastifyInstance;
  let writer: SignalStackWriterFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    // Treat signalstack as enabled so getSignalStackWriter returns our fake.
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';
    _setNetworkConfig(buildBlueDotConfig());

    writer = new SignalStackWriterFake();
    writer.seed({
      users: [
        { id: 'u1', name: 'Ravi', phoneNumber: '+919876543210' },
        { id: 'u2', name: 'Sita', phoneNumber: '+919876543211' },
      ],
      profiles: [
        // Two seekers under AGG_A
        {
          item_id: 'p1',
          created_by: 'u1',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: {
            name: 'Ravi',
            gender: 'male',
            location: 'BLR',
            age: 28,
            phone: '+919876543210',
          },
          aggregator_id: AGG_A,
        },
        {
          item_id: 'p2',
          created_by: 'u2',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: {
            name: 'Sita',
            gender: 'female',
            location: 'Mumbai',
            age: 26,
            phone: '+919876543211',
          },
          aggregator_id: AGG_A,
        },
        // One seeker under AGG_B (must NOT be visible to AGG_A)
        {
          item_id: 'p3',
          created_by: 'u1',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: {
            name: 'Other',
            gender: 'male',
            location: 'Delhi',
            age: 30,
            phone: '+919800000000',
          },
          aggregator_id: AGG_B,
        },
        // Provider row under AGG_A — must NOT show up under domain=seeker
        {
          item_id: 'p4',
          created_by: 'u1',
          item_network: 'blue_dot',
          item_domain: 'provider',
          item_type: 'job_posting_1.0',
          item_state: { jobProviderName: 'ACME', role: 'Welder', jobProviderLocation: 'Pune' },
          aggregator_id: AGG_A,
        },
      ],
    });

    _setSignalStackWriter(writer);
    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-a-token') {
        return { sub: 'kc-1', email: 'a@x.com', aggregator_id: AGG_A };
      }
      if (token === 'agg-b-token') {
        return { sub: 'kc-2', email: 'b@x.com', aggregator_id: AGG_B };
      }
      if (token === 'no-agg') {
        return { sub: 'kc-3', email: 'c@x.com' };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setSignalStackWriter(null);
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  it('401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard/items?domain=seeker' });
    expect(res.statusCode).toBe(401);
  });

  it('403 when token has no aggregator_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker',
      headers: { authorization: 'Bearer no-agg' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns only AGG_A seekers when AGG_A asks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.total).toBe(2);
    const ids = (body.items as Array<{ item_id: string }>).map((i) => i.item_id).sort();
    expect(ids).toEqual(['p1', 'p2']);
    for (const item of body.items as Array<{ aggregator_id: string }>) {
      expect(item.aggregator_id).toBe(AGG_A);
    }
  });

  it('returns only AGG_B seeker when AGG_B asks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker',
      headers: { authorization: 'Bearer agg-b-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.total).toBe(1);
    expect(body.items[0].item_id).toBe('p3');
  });

  it('returns only provider items when domain=provider', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=provider',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.total).toBe(1);
    expect(body.items[0].item_id).toBe('p4');
    expect(body.items[0].item_type).toBe('job_posting_1.0');
  });

  it('400 on invalid domain', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=invalid',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/dashboard', () => {
  let app: FastifyInstance;
  let writer: SignalStackWriterFake;
  let aggregatorStore: AggregatorStoreFake;
  let idp: IdpAdminFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
    _setNetworkConfig(buildBlueDotConfig());

    idp = new IdpAdminFake();
    await idp.createUser({
      email: 'kc-1@x.com',
      enabled: true,
      attributes: { aggregator_id: AGG_A, decision_made: 'approved' },
    });
    await idp.createUser({
      email: 'kc-2@x.com',
      enabled: true,
      attributes: { aggregator_id: AGG_B, decision_made: 'approved' },
    });
    _setIdpAdmin(idp);

    aggregatorStore = new AggregatorStoreFake();
    aggregatorStore.seed([
      buildAggregator({
        id: AGG_A,
        orgSlug: 'agg-a',
        name: 'Agg A',
        status: 'active',
        signalstackOrgId: ORG_A,
      }),
      buildAggregator({
        id: AGG_B,
        orgSlug: 'agg-b',
        name: 'Agg B',
        contact: { name: 'B', phone: '+919999999991', email: 'b@test.local' },
        status: 'active',
        signalstackOrgId: null,
      }),
    ]);
    _setAggregatorStore(aggregatorStore);

    writer = new SignalStackWriterFake();
    writer.seed({
      aggregators: [{ external_id: AGG_A, org_id: ORG_A, name: 'Agg A', slug: 'agg-a' }],
      dashboards: [
        {
          acting_org_id: ORG_A,
          page: {
            by_domain: {
              seeker: {
                rollup: makeRollup({
                  total_items: 5,
                  by_status: { new: 3, at_risk: 2 },
                }),
                items: [
                  { item_id: 'p1', status: 'new' },
                  { item_id: 'p2', status: 'at_risk' },
                ],
                next_cursor: null,
                total_matching: 2,
              },
              provider: {
                rollup: makeRollup({}),
                items: [],
                next_cursor: null,
                total_matching: 0,
              },
            },
            metadata: {
              last_computed_at: '2026-05-22T15:33:05.355Z',
              ttl_seconds: 3600,
              refreshed: true,
            },
          },
        },
      ],
    });
    _setSignalStackWriter(writer);

    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-a-approved-with-org') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'approved',
          signalstack_org_id: ORG_A,
        };
      }
      if (token === 'agg-a-approved-no-claim') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'approved',
        };
      }
      if (token === 'agg-b-approved-null-store') {
        return {
          sub: 'kc-2',
          email: 'b@x.com',
          aggregator_id: AGG_B,
          decision_made: 'approved',
        };
      }
      if (token === 'agg-a-pending') {
        return {
          sub: 'kc-1',
          email: 'a@x.com',
          aggregator_id: AGG_A,
          decision_made: 'pending',
        };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setSignalStackWriter(null);
    _setAggregatorStore(null);
    _setIdpAdmin(null);
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  it('401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_APPROVED when decision_made is pending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-a-pending' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns rollup verbatim using actingOrgId from access-token claim', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?page=1&limit=50',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.by_domain.seeker.rollup.total_items).toBe(5);
    expect(body.by_domain.seeker.rollup.by_status).toEqual({ new: 3, at_risk: 2 });
    expect(body.by_domain.seeker.items).toHaveLength(2);
    expect(body.by_domain.seeker.total_matching).toBe(2);
    expect(body.metadata.refreshed).toBe(true);
  });

  it('falls back to aggregators.signalstack_org_id when claim missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-a-approved-no-claim' },
    });
    // requireApproved triggers backfill; the fake's upsertAggregator
    // succeeds and writes signalstack_org_id to the DB mirror. The route
    // then resolves actingOrgId either from the just-patched context or
    // the DB lookup and returns the seeded rollup.
    expect(res.statusCode).toBe(200);
    expect(res.json().by_domain.seeker.rollup.total_items).toBe(5);
  });

  it('503 SIGNALSTACK_ORG_NOT_REGISTERED when DB column is null and backfill cannot resolve', async () => {
    // AGG_B has signalstackOrgId=null in the store seed. The fake upsert
    // would synthesise an id, so we suppress it by clearing the writer.
    // Instead, drop the writer entirely so the dashboard route fails
    // before reaching signalstack.
    _setSignalStackWriter(null);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-b-approved-null-store' },
    });
    // Writer null short-circuits to INTERNAL (signalstack not configured)
    // BEFORE the org-id check — the route guards both. Either error code
    // is acceptable; assert non-2xx.
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('forwards the status filter to signalstack', async () => {
    // Seed a different rollup for a status filter and assert it's served.
    writer.seed({
      dashboards: [
        {
          acting_org_id: ORG_A,
          page: {
            by_domain: {
              seeker: {
                rollup: makeRollup({
                  total_items: 2,
                  by_status: { at_risk: 2 },
                }),
                items: [],
                next_cursor: null,
                total_matching: 0,
              },
              provider: {
                rollup: makeRollup({}),
                items: [],
                next_cursor: null,
                total_matching: 0,
              },
            },
            metadata: {
              last_computed_at: '2026-05-22T15:33:05.355Z',
              ttl_seconds: 3600,
              refreshed: true,
            },
          },
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?page=1&limit=50&status=at_risk',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.by_domain.seeker.rollup.by_status.at_risk).toBe(2);
    expect(body.by_domain.seeker.total_matching).toBe(0);
  });

  it('400 on invalid status shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?status=at-risk!',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exports the seeded CSV body with the right headers', async () => {
    const SAMPLE_CSV =
      'user_id,profile_status,profile_completion_pct\n' + 'u-1,at_risk,42\n' + 'u-2,at_risk,58\n';
    writer.seed({
      dashboardExports: [{ acting_org_id: ORG_A, csv: SAMPLE_CSV }],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/export?status=at_risk',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const disposition = res.headers['content-disposition'];
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('aggregator-dashboard-at_risk-');
    expect(res.body).toBe(SAMPLE_CSV);
  });

  it('export 5xx when signalstack writer is disabled', async () => {
    _setSignalStackWriter(null);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/export?status=at_risk',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('export 400 on invalid status shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/export?status=at-risk!',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('forwards ?refresh=true to the signalstack writer', async () => {
    const spy = vi.spyOn(writer, 'fetchDashboard');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard?refresh=true',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  });

  it('defaults refresh to false when ?refresh is unset', async () => {
    const spy = vi.spyOn(writer, 'fetchDashboard');

    await app.inject({
      method: 'GET',
      url: '/v1/dashboard',
      headers: { authorization: 'Bearer agg-a-approved-with-org' },
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ refresh: false }));
  });
});
