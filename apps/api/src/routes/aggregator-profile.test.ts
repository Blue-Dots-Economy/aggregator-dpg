import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import {
  AggregatorOrgStoreFake,
  buildAggregatorOrg,
  _setAggregatorOrgStore,
} from '../services/aggregator-org-store/index.js';

const aggregatorId = '22222222-2222-2222-2222-222222222222';

describe('aggregator profile routes', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let orgStore: AggregatorOrgStoreFake;
  let idp: IdpAdminFake;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    aggregatorStore = new AggregatorStoreFake();
    aggregatorStore.seed([buildAggregator({ id: aggregatorId, orgSlug: 'trrain-zzzz' })]);
    _setAggregatorStore(aggregatorStore);
    orgStore = new AggregatorOrgStoreFake();
    _setAggregatorOrgStore(orgStore);

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
    _setAggregatorOrgStore(null);
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

  it('GET returns the aggregator with identity from the token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.aggregator_id).toBe(aggregatorId);
    // The removed `aggregator_profile` keys must not reappear in the response.
    for (const k of [
      'contact_name',
      'personas',
      'services',
      'verified_certificate',
      'profile_completed_at',
      'is_complete',
    ]) {
      expect(body).not.toHaveProperty(k);
    }
    const id = body.identity as Record<string, unknown>;
    expect(id.first_name).toBe('Asha');
    expect(id.last_name).toBe('Rao');
    expect(id.email).toBe('asha@trrain.org');
    expect(id.phone).toBe('+919876543210');
    expect(id.email_verified).toBe(true);
    expect(id.active).toBe(true);
  });

  it('PATCH rejects an empty body — `aggregator` is required', async () => {
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

  it('PATCH rejects a `profile` key — the profile half of the body is gone', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: { aggregator: { name: 'Still Valid' }, profile: { contact_name: 'Asha' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
  });

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

  it('PATCH 409 PHONE_EXISTS (before any Keycloak write) when an org owner holds the phone', async () => {
    orgStore.seed([
      buildAggregatorOrg({
        ownerEmail: 'boss@else.org',
        ownerPhone: '+919876543299',
        status: 'active',
      }),
    ]);
    let kcWrites = 0;
    idp.setAttributes = async () => {
      kcWrites++;
      return { ok: true, value: undefined };
    };
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543299', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
    expect(kcWrites).toBe(0);
  });

  it('PATCH 409 PHONE_EXISTS (before any Keycloak write) when another coordinator holds the phone', async () => {
    aggregatorStore.seed([
      buildAggregator({
        id: '00000000-0000-0000-0000-00000000beef',
        orgSlug: 'other-coord',
        contact: { name: 'Other', phone: '+919876543288', email: 'other@x.org' },
      }),
    ]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543288', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
  });

  it('PATCH 409 CONFLICT before any Keycloak write when the contact is shared with an org owner', async () => {
    const shared = 'c'.repeat(64);
    aggregatorStore.seed([
      buildAggregator({
        id: aggregatorId,
        orgSlug: 'trrain-zzzz',
        contactId: shared,
        contact: { name: 'Both', phone: '+919876543201', email: 'both@trrain.org' },
      }),
    ]);
    orgStore.seed([
      buildAggregatorOrg({
        contactId: shared,
        ownerEmail: 'both@trrain.org',
        ownerPhone: '+919876543201',
        status: 'active',
      }),
    ]);
    let kcWrites = 0;
    idp.setAttributes = async () => {
      kcWrites++;
      return { ok: true, value: undefined };
    };
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Both', phone: '+919876543202', email: 'both@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
    expect(kcWrites).toBe(0);
  });

  it('PATCH restores the Keycloak phone when the database update fails', async () => {
    const phones: string[] = [];
    idp.setAttributes = async (_id, attrs) => {
      phones.push(String((attrs as Record<string, unknown>)['phoneNumber']));
      return { ok: true, value: undefined };
    };
    aggregatorStore.update = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/aggregators/profile/me',
      headers: { authorization: 'Bearer good-token' },
      payload: {
        aggregator: {
          contact: { name: 'Asha', phone: '+919876543277', email: 'asha@trrain.org' },
        },
      },
    });
    expect(res.statusCode).toBe(503);
    expect(phones).toHaveLength(2);
    expect(phones[0]).toBe('+919876543277');
    expect(phones[1]).not.toBe('+919876543277'); // put back to the previous phone
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
    const body = res.json() as Record<string, unknown>;
    expect(body.name).toBe('TRRAIN Renamed');
    expect(body.url).toBe('https://trrain.example.org');
    for (const k of [
      'contact_name',
      'personas',
      'services',
      'verified_certificate',
      'profile_completed_at',
      'is_complete',
    ]) {
      expect(body).not.toHaveProperty(k);
    }
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
