/**
 * Tests for the lifecycle extensions to `GET /v1/dashboard/items`:
 *   - per-item `lifecycle_status` on the response
 *   - `meta.tiles` block with `{ draft, live, paused, account_only }`
 *   - `?lifecycle=` query filter (rejects unknown values)
 *   - back-compat: items without `lifecycle_status` are treated as `live`
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';

const AGG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('GET /v1/dashboard/items — lifecycle', () => {
  let app: FastifyInstance;
  let writer: SignalStackWriterFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';
    _setNetworkConfig(buildBlueDotConfig());

    writer = new SignalStackWriterFake();
    _setSignalStackWriter(writer);

    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-a-token') {
        return { sub: 'kc-1', email: 'a@x.com', aggregator_id: AGG_A };
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

  it('returns lifecycle_status on each item', async () => {
    writer.seedItem('item-1', {
      lifecycle_status: 'draft',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    writer.seedItem('item-2', {
      lifecycle_status: 'live',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const item1 = (body.items as Array<{ item_id: string; lifecycle_status?: string }>).find(
      (i) => i.item_id === 'item-1',
    );
    expect(item1).toBeDefined();
    expect(item1!.lifecycle_status).toBe('draft');

    const item2 = (body.items as Array<{ item_id: string; lifecycle_status?: string }>).find(
      (i) => i.item_id === 'item-2',
    );
    expect(item2).toBeDefined();
    expect(item2!.lifecycle_status).toBe('live');
  });

  it('returns meta.tiles with per-status counts', async () => {
    writer.seedItem('a', {
      lifecycle_status: 'draft',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    writer.seedItem('b', {
      lifecycle_status: 'live',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    writer.seedItem('c', {
      lifecycle_status: 'live',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    writer.seedItem('d', {
      lifecycle_status: 'paused',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.meta.tiles).toEqual(expect.objectContaining({ draft: 1, live: 2, paused: 1 }));
    expect(typeof body.meta.tiles.account_only).toBe('number');
    expect(Object.keys(body.meta.tiles).sort()).toEqual(
      ['account_only', 'draft', 'live', 'paused'].sort(),
    );
  });

  it('filters items via ?lifecycle=draft (tiles still reflect totals)', async () => {
    writer.seedItem('a', {
      lifecycle_status: 'draft',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    writer.seedItem('b', {
      lifecycle_status: 'live',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker&lifecycle=draft',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    for (const it of body.items as Array<{ lifecycle_status?: string }>) {
      expect(it.lifecycle_status).toBe('draft');
    }
    // Tiles still reflect totals across every state, not the filtered slice.
    expect(body.meta.tiles.draft).toBe(1);
    expect(body.meta.tiles.live).toBe(1);
  });

  it('treats items without lifecycle_status as live (back-compat)', async () => {
    writer.seedItem('a', {
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.meta.tiles.live).toBeGreaterThan(0);
    expect(
      (body.items as Array<{ lifecycle_status?: string }>).every(
        (i) => i.lifecycle_status === 'live',
      ),
    ).toBe(true);
  });

  it('returns empty items list when ?lifecycle=account_only (account-only rows live in participants, not items)', async () => {
    writer.seedItem('a', {
      lifecycle_status: 'draft',
      aggregator_id: AGG_A,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
    });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker&lifecycle=account_only',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.items).toEqual([]);
    // Tiles still reflect totals across every state.
    expect(body.meta.tiles.draft).toBe(1);
  });

  it('400s on an unknown ?lifecycle value', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker&lifecycle=bogus',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('account_only tile is a non-negative number even with no items', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().meta.tiles.account_only).toBeGreaterThanOrEqual(0);
  });

  it('tiles reflect the full dataset even when items is paginated to a smaller page', async () => {
    // Seed 60 items across all three lifecycle states. Default page limit
    // is 50, so a naive implementation would count only the first 50 and
    // mis-report tile totals.
    const seedOne = (id: string, status: 'draft' | 'live' | 'paused') => {
      writer.seedItem(id, {
        lifecycle_status: status,
        aggregator_id: AGG_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
      });
    };
    for (let i = 0; i < 40; i++) seedOne(`live-${i}`, 'live');
    for (let i = 0; i < 15; i++) seedOne(`draft-${i}`, 'draft');
    for (let i = 0; i < 5; i++) seedOne(`paused-${i}`, 'paused');

    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker&limit=10',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.items).toHaveLength(10);
    expect(body.meta.total).toBe(60);
    expect(body.meta.tiles).toEqual(expect.objectContaining({ draft: 15, live: 40, paused: 5 }));
    expect(body.meta.tiles_truncated).toBe(false);
  });
});
