import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import {
  AggregatorProfileStoreFake,
  _setAggregatorProfileStore,
  buildAggregatorProfile,
} from '../services/aggregator-profile-store/index.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _resetProfileValidator } from '../services/profile-validator.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';

const aggregatorId = '22222222-2222-2222-2222-222222222222';

describe('aggregator profile routes', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let profileStore: AggregatorProfileStoreFake;

  beforeEach(async () => {
    _resetJwks();
    _resetProfileValidator();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    aggregatorStore = new AggregatorStoreFake();
    aggregatorStore.seed([buildAggregator({ id: aggregatorId, orgSlug: 'trrain-zzzz' })]);
    profileStore = new AggregatorProfileStoreFake();
    profileStore.seed([buildAggregatorProfile({ aggregatorId })]);

    _setAggregatorStore(aggregatorStore);
    _setAggregatorProfileStore(profileStore);

    const idp = new IdpAdminFake();
    await idp.createUser({
      email: 'asha@trrain.org',
      firstName: 'Asha',
      lastName: 'Rao',
      phone: '+919876543210',
      attributes: { aggregator_id: aggregatorId, association: 'TRRAIN' },
    });
    _setIdpAdmin(idp);
    // sub claim is populated lazily — use the KC user id created above so
    // findById resolves attributes including org name.
    const ashaUser = await idp.findByEmail('asha@trrain.org');
    const ashaId = ashaUser.ok && ashaUser.value ? ashaUser.value.id : 'kc-user-1';
    _setAccessTokenVerifier(async (token) => {
      if (token === 'good-token') {
        return {
          sub: ashaId,
          email: 'asha@trrain.org',
          email_verified: true,
          given_name: 'Asha',
          family_name: 'Rao',
          phone_number: '+919876543210',
          aggregator_id: aggregatorId,
        };
      }
      if (token === 'no-attribute') {
        return { sub: 'kc-user-2', email: 'x@y.z' };
      }
      throw new Error('invalid token');
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setAggregatorProfileStore(null);
    _setAccessTokenVerifier(null);
    _setIdpAdmin(null);
  });

  it('GET returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/aggregators/profile/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET returns 403 when token has no aggregator_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer no-attribute' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET returns the profile with identity from token + is_complete=false on empty data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.aggregator_id).toBe(aggregatorId);
    expect(body.is_complete).toBe(false);
    const id = body.identity as Record<string, unknown>;
    expect(id.first_name).toBe('Asha');
    expect(id.last_name).toBe('Rao');
    expect(id.email).toBe('asha@trrain.org');
    expect(id.phone).toBe('+919876543210');
    expect(id.email_verified).toBe(true);
    expect(id.active).toBe(true);
  });

  it('PATCH rejects body that includes neither `aggregator` nor `profile`', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCHEMA_VALIDATION');
  });

  it('PATCH profile stamps profile_completed_at when contact_name + persona + service are all present', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        profile: {
          contact_name: 'Asha Rao',
          personas: [{ id: 'persona-iti-seeker', name: 'ITI Seeker' }],
          services: [{ id: 'service-bluedots-job', name: 'BlueDots Job' }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.is_complete).toBe(true);
    expect(body.profile_completed_at).toBeTruthy();

    const stored = await profileStore.findByAggregatorId(aggregatorId);
    if (stored.ok && stored.value) {
      expect(stored.value.contactName).toBe('Asha Rao');
      expect(stored.value.profileCompletedAt).not.toBeNull();
    }
  });

  it('PATCH profile rejects unknown persona/service IDs against the schema registry', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        profile: {
          contact_name: 'Asha',
          personas: [{ id: 'persona-bogus', name: 'Bogus' }],
          services: [{ id: 'service-bluedots-job', name: 'BlueDots' }],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; fields?: Record<string, string[]> } };
    expect(body.error.code).toBe('SCHEMA_VALIDATION');
    expect(body.error.fields?.unknown_personas).toContain('persona-bogus');
  });
});
