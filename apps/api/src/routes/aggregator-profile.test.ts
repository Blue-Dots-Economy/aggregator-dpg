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
  let idp: IdpAdminFake;

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

    idp = new IdpAdminFake();
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

  // ---------------------------------------------------------------------------
  // GET failure branches
  // ---------------------------------------------------------------------------

  it('GET returns 503 when the aggregator store fails', async () => {
    aggregatorStore.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET returns 404 when the aggregator row is missing', async () => {
    aggregatorStore.findById = async () => ({ ok: true, value: null });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET returns 503 when the profile store fails', async () => {
    profileStore.findByAggregatorId = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET returns 404 when the profile row is missing', async () => {
    profileStore.findByAggregatorId = async () => ({ ok: true, value: null });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET falls back to JWT claims when the KC user lookup fails', async () => {
    idp.findById = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { identity: Record<string, unknown> };
    // JWT claims still populate identity even though the KC lookup failed.
    expect(body.identity.first_name).toBe('Asha');
  });

  it('GET falls back to JWT claims when the KC user lookup throws', async () => {
    idp.findById = async () => {
      throw new Error('kc unreachable');
    };
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { identity: Record<string, unknown> };
    expect(body.identity.first_name).toBe('Asha');
  });

  // ---------------------------------------------------------------------------
  // PATCH aggregator.contact branch
  // ---------------------------------------------------------------------------

  // Note: PATCH's own INVALID_PHONE branch (normalisePhone failing) is not
  // reachable via a real HTTP request — `BecknContactSchema`'s phone regex
  // (`^(\+?\d{10,15}|\d{10})$`) already enforces the same 10-15-digit window
  // that `normalisePhone` checks, at the Fastify schema-validation layer, so
  // any input that would fail `normalisePhone` is already rejected as 400
  // SCHEMA_VALIDATION before the handler body runs. Left uncovered.

  it('PATCH aborts with IDP_UNAVAILABLE (no DB write) when mirroring the phone to Keycloak fails', async () => {
    idp.setAttributes = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543211', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
    const stored = await aggregatorStore.findById(aggregatorId);
    if (stored.ok) expect(stored.value?.contact.phone).not.toBe('+919876543211');
  });

  it('PATCH updates aggregator name/url/locations/consent successfully', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          name: 'TRRAIN Renamed',
          url: 'https://trrain.example.org',
          locations: [],
          consent: {
            value: true,
            given_at: '2026-01-15T10:00:00Z',
            valid_till: '2027-01-15T10:00:00Z',
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; url: string | null };
    expect(body.name).toBe('TRRAIN Renamed');
    expect(body.url).toBe('https://trrain.example.org');
  });

  it.each([
    ['DUPLICATE_PHONE', 409, 'PHONE_EXISTS'],
    ['DUPLICATE_EMAIL', 409, 'USER_EXISTS'],
    ['CHECK_VIOLATION', 400, 'SCHEMA_VALIDATION'],
    ['DUPLICATE_SLUG', 503, 'DUPLICATE_SLUG'],
    ['DB_UNAVAILABLE', 503, 'DB_UNAVAILABLE'],
    ['NOT_FOUND', 404, 'NOT_FOUND'],
  ] as const)(
    'PATCH maps aggregatorStore.update error %s to %d %s',
    async (storeCode, status, errCode) => {
      aggregatorStore.update = async () => ({
        ok: false,
        error: { code: storeCode, message: 'store error' },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/aggregators/profile/me',
        headers: { authorization: 'Bearer good-token' },
        payload: { aggregator: { name: 'New Name' } },
      });
      expect(res.statusCode).toBe(status);
      expect((res.json() as { error: { code: string } }).error.code).toBe(errCode);
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH profile branch
  // ---------------------------------------------------------------------------

  it('PATCH updates verified_certificate on the profile', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        profile: {
          verified_certificate: [
            {
              key_id: 'key-1',
              public_key: 'pubkey-data',
              algorithm: 'RS256',
              valid_till: '2027-01-15T10:00:00Z',
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { verified_certificate: Array<{ key_id: string }> };
    expect(body.verified_certificate).toHaveLength(1);
    expect(body.verified_certificate[0]?.key_id).toBe('key-1');
  });

  it('PATCH returns 404 when the profile row is missing at update time', async () => {
    profileStore.findByAggregatorId = async () => ({ ok: true, value: null });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: { profile: { contact_name: 'Asha' } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH clears profile_completed_at when a previously-complete profile becomes incomplete', async () => {
    await profileStore.update(aggregatorId, {
      updatedBy: 'test',
      contactName: 'Asha Rao',
      personas: [{ id: 'persona-iti-seeker', name: 'ITI Seeker' }],
      services: [{ id: 'service-bluedots-job', name: 'BlueDots Job' }],
      profileCompletedAt: new Date(),
    });
    const before = await profileStore.findByAggregatorId(aggregatorId);
    expect(before.ok && before.value?.profileCompletedAt).not.toBeNull();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: { profile: { personas: [] } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { is_complete: boolean; profile_completed_at: string | null };
    expect(body.is_complete).toBe(false);
    expect(body.profile_completed_at).toBeNull();
  });

  it('PATCH maps a profile store NOT_FOUND error to 404', async () => {
    profileStore.update = async () => ({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'gone' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: { profile: { contact_name: 'Asha' } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH maps a profile store DB_UNAVAILABLE error to 503', async () => {
    profileStore.update = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: { profile: { contact_name: 'Asha' } },
    });
    expect(res.statusCode).toBe(503);
  });

  it('PATCH returns 500 INTERNAL when the post-write read fails', async () => {
    // PATCH's only aggregatorStore.findById call is the post-write "echo the
    // merged view" read — nulling it out simulates the row vanishing between
    // the write and the re-read.
    aggregatorStore.findById = async () => ({ ok: true, value: null });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: { aggregator: { name: 'Post Write Fail' } },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
  });
});
