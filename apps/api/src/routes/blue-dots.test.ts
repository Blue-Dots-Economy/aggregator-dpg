import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';

const AGG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
  });

  it('401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/blue-dots/items?domain=seeker' });
    expect(res.statusCode).toBe(401);
  });

  it('403 when token has no aggregator_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/blue-dots/items?domain=seeker',
      headers: { authorization: 'Bearer no-agg' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns only AGG_A seekers when AGG_A asks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/blue-dots/items?domain=seeker',
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
      url: '/v1/blue-dots/items?domain=seeker',
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
      url: '/v1/blue-dots/items?domain=provider',
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
      url: '/v1/blue-dots/items?domain=invalid',
      headers: { authorization: 'Bearer agg-a-token' },
    });
    expect(res.statusCode).toBe(400);
  });
});
