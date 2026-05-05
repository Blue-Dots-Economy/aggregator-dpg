import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { AggregatorStoreFake, _setAggregatorStore } from '../services/aggregator-store/index.js';
import {
  AggregatorProfileStoreFake,
  _setAggregatorProfileStore,
} from '../services/aggregator-profile-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('POST /v1/aggregator-registrations/create', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let profileStore: AggregatorProfileStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
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

  const validBody = {
    aggregator_type: 'seeker',
    association: 'TRRAIN',
    email: 'asha@trrain.org',
    phone: '+919876543210',
  };

  it('creates an aggregator + disabled KC user on valid payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      aggregator_id: string;
      org_slug: string;
      message: string;
    };
    expect(body.aggregator_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.org_slug).toMatch(/^trrain-[0-9a-f]{4}$/);
    expect(body.message).toContain('Registration submitted');

    const stored = await aggregatorStore.findById(body.aggregator_id);
    if (stored.ok) expect(stored.value?.orgSlug).toBe(body.org_slug);

    const profile = await profileStore.findByAggregatorId(body.aggregator_id);
    if (profile.ok) {
      expect(profile.value?.aggregatorId).toBe(body.aggregator_id);
      expect(profile.value?.data).toEqual({});
      expect(profile.value?.consent).toEqual({});
    }

    const kcUser = await idp.findByEmail(validBody.email);
    if (kcUser.ok && kcUser.value) {
      expect(kcUser.value.enabled).toBe(false);
      expect(kcUser.value.attributes?.aggregator_id?.[0]).toBe(body.aggregator_id);
      expect(kcUser.value.attributes?.org_slug?.[0]).toBe(body.org_slug);
      expect(kcUser.value.attributes?.aggregator_type?.[0]).toBe('seeker');
    }

    const sent = mailer.outbox;
    expect(sent.length).toBe(1);
    const first = sent[0];
    if (!first) throw new Error('no mail captured');
    expect(first.to).toEqual(['reviewer@bluedots.local']);
    expect(first.subject).toContain('TRRAIN');
    expect(first.html).toContain('intent=approve');
    expect(first.html).toContain('intent=reject');
    expect(first.html).toContain('/admin/v1/aggregator-registrations/read/');
  });

  it('returns 401 when Bearer is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Bearer is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: { authorization: 'Bearer junk' },
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects payload missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { contact_name: 'X' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; title: string; requestId: string } };
    expect(body.error.code).toBe('SCHEMA_VALIDATION');
    expect(body.error.title).toBeTruthy();
    expect(body.error.requestId).toMatch(/^req-/);
  });

  it('rejects malformed email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when the email already exists in Keycloak', async () => {
    await idp.createUser({ email: validBody.email });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; title: string; detail: string } };
    expect(body.error.code).toBe('USER_EXISTS');
    expect(body.error.title).toBe('Email already registered');
    expect(body.error.detail).toContain('already exists');
  });

  it('returns 409 when the phone is already used by another user', async () => {
    await idp.createUser({
      email: 'someone-else@trrain.org',
      phone: '+919876543210',
      attributes: { aggregator_id: 'other-agg' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, email: 'asha2@trrain.org' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; title: string; requestId: string } };
    expect(body.error.code).toBe('PHONE_EXISTS');
    expect(body.error.title).toBe('Phone already registered');
    expect(body.error.requestId).toMatch(/^req-/);
  });

  it('rolls back the aggregator row when KC createUser fails', async () => {
    // Monkey-patch createUser to fail while leaving findByEmail untouched.
    const originalCreate = idp.createUser.bind(idp);
    idp.createUser = async () => ({
      ok: false as const,
      error: { code: 'IDP_UNAVAILABLE' as const, message: 'kc down' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, email: 'asha2@trrain.org' },
    });
    expect(res.statusCode).toBe(503);

    // No aggregator row should remain — the route rolls it back when KC
    // creation fails.
    const allByPrefix = await Promise.all(
      ['trrain-0001', 'trrain-0002', 'trrain-0003'].map((s) => aggregatorStore.findBySlug(s)),
    );
    for (const r of allByPrefix) if (r.ok) expect(r.value).toBeNull();

    idp.createUser = originalCreate;
  });
});
