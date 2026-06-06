/**
 * Tests for GET /public/v1/aggregators/:orgSlug/lookup.
 *
 * Covers the anonymous identity-probe endpoint that the registration form
 * calls before opening the schema: the route resolves the aggregator's
 * signalstack org id by slug, then wraps `SignalStackWriterBase.probeUser`
 * (an `account_only` call into signals) to classify the identity as
 *   - truly new (`user_exists: false`)
 *   - own user with no item / with lifecycle summary
 *   - foreign-owned (`owned_elsewhere: true`, lifecycle_summary null)
 *
 * @module apps/api/routes/public-lookup.test
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-1';

describe('GET /public/v1/aggregators/:orgSlug/lookup', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let signalstack: SignalStackWriterFake;

  beforeEach(async () => {
    // Treat signalstack as enabled so getSignalStackWriter returns our fake.
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';

    aggregatorStore = new AggregatorStoreFake();
    aggregatorStore.seed([
      buildAggregator({
        id: AGG_ID,
        orgSlug: 'acme',
        name: 'Acme Aggregator',
        status: 'active',
        signalstackOrgId: ORG_ID,
      }),
    ]);
    _setAggregatorStore(aggregatorStore);

    signalstack = new SignalStackWriterFake();
    _setSignalStackWriter(signalstack);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setSignalStackWriter(null);
  });

  it('returns user_exists=false for a new identity', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=new@example.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      user_exists: false,
      owned_elsewhere: false,
      lifecycle_summary: null,
    });
  });

  it('returns owned_elsewhere=true with null lifecycle for a foreign user', async () => {
    signalstack.seedForeignUser({ email: 'shared@x.com' });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=shared@x.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      user_exists: boolean;
      owned_elsewhere: boolean;
      lifecycle_summary: unknown;
    };
    expect(body.user_exists).toBe(true);
    expect(body.owned_elsewhere).toBe(true);
    expect(body.lifecycle_summary).toBeNull();
  });

  it('returns lifecycle_summary for an own user with a draft item', async () => {
    signalstack.seedOwnUser({
      actingOrgId: ORG_ID,
      email: 'me@here.com',
      item: { item_id: 'item-1', lifecycle_status: 'draft', completion_pct: 40 },
    });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=me@here.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      user_exists: boolean;
      owned_elsewhere: boolean;
      lifecycle_summary: {
        primary_item: { item_id: string; lifecycle_status: string; completion_pct: number };
      } | null;
    };
    expect(body.user_exists).toBe(true);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.lifecycle_summary?.primary_item.item_id).toBe('item-1');
    expect(body.lifecycle_summary?.primary_item.lifecycle_status).toBe('draft');
    expect(body.lifecycle_summary?.primary_item.completion_pct).toBe(40);
  });

  it('400s when neither email nor phone_number is supplied', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(400);
  });

  it('404s when the aggregator slug is unknown', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/unknown/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(404);
  });
});
