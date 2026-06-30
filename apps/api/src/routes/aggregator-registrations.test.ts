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
    name: 'TRRAIN',
    type: 'seeker',
    contact: {
      name: 'Asha Kumari',
      phone: '+919876543210',
      email: 'asha@trrain.org',
    },
    consent: {
      value: true,
      given_at: '2026-01-15T10:00:00Z',
      valid_till: '2027-01-15T10:00:00Z',
    },
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
      expect(profile.value?.contactName).toBeNull();
      expect(profile.value?.personas).toEqual([]);
      expect(profile.value?.services).toEqual([]);
      expect(profile.value?.verifiedCertificate).toEqual([]);
      expect(profile.value?.profileCompletedAt).toBeNull();
    }

    const kcUser = await idp.findByEmail(validBody.contact.email);
    if (kcUser.ok && kcUser.value) {
      expect(kcUser.value.enabled).toBe(false);
      expect(kcUser.value.attributes?.aggregator_id?.[0]).toBe(body.aggregator_id);
      expect(kcUser.value.attributes?.aggregator_type?.[0]).toBe(validBody.type);
      expect(kcUser.value.attributes?.phoneNumber?.[0]).toBe(validBody.contact.phone);
      expect(kcUser.value.attributes?.decision_made?.[0]).toBe('pending');
      // Removed attributes per the new flow:
      expect(kcUser.value.attributes?.org_slug).toBeUndefined();
      expect(kcUser.value.attributes?.association).toBeUndefined();
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
      payload: { name: 'X' },
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
      payload: { ...validBody, contact: { ...validBody.contact, email: 'not-an-email' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when the email already exists in Keycloak', async () => {
    await idp.createUser({ email: validBody.contact.email });
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
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'asha2@trrain.org' },
      },
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
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'asha2@trrain.org' },
      },
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

  async function seedPending(overrides?: { status?: 'pending' | 'inactive' | 'active' }) {
    const created = await aggregatorStore.create({
      orgSlug: 'trrain-aaaa',
      actorType: 'aggregator',
      name: 'TRRAIN',
      type: 'seeker',
      url: null,
      contact: {
        name: 'Asha Kumari',
        phone: '+919876543210',
        email: 'asha@trrain.org',
      },
      locations: [],
      consent: validBody.consent,
      createdBy: 'self',
      updatedBy: 'self',
    });
    if (!created.ok) throw new Error('seed failed');
    const id = created.value.id;
    if (overrides?.status && overrides.status !== 'pending') {
      await aggregatorStore.updateStatus(id, overrides.status, 'admin');
    }
    await idp.createUser({
      email: 'asha@trrain.org',
      phone: '+919876543210',
      enabled: false,
      attributes: {
        aggregator_id: id,
        aggregator_type: 'seeker',
        phoneNumber: '+919876543210',
        decision_made: overrides?.status === 'inactive' ? 'rejected' : 'pending',
      },
    });
    return id;
  }

  it('refreshes a pending registration on resubmit instead of 409', async () => {
    const id = await seedPending();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { aggregator_id: string; status: string };
    expect(body.aggregator_id).toBe(id);
    expect(body.status).toBe('pending');
    // A fresh admin-review email was re-sent.
    expect(mailer.outbox.length).toBe(1);
    expect(mailer.outbox[0]?.html).toContain('intent=approve');
  });

  it('reactivates a rejected (inactive) registration on resubmit', async () => {
    const id = await seedPending({ status: 'inactive' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(200);
    const stored = await aggregatorStore.findById(id);
    if (stored.ok) expect(stored.value?.status).toBe('pending');
    const kc = await idp.findByEmail(validBody.contact.email);
    if (kc.ok && kc.value) {
      expect(kc.value.enabled).toBe(false);
      expect(kc.value.attributes?.decision_made?.[0]).toBe('pending');
    }
  });

  it('still returns 409 when the email belongs to an active aggregator', async () => {
    await seedPending({ status: 'active' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
  });

  it('rejects reclaim when the new phone is taken by a different record', async () => {
    await seedPending(); // asha@trrain.org / +919876543210, pending
    // A different ACTIVE aggregator already owns the phone the resubmit carries.
    const other = await aggregatorStore.create({
      orgSlug: 'other-bbbb',
      actorType: 'aggregator',
      name: 'Other',
      type: 'seeker',
      url: null,
      contact: { name: 'X', phone: '+911111111111', email: 'x@other.org' },
      locations: [],
      consent: validBody.consent,
      createdBy: 'self',
      updatedBy: 'self',
    });
    if (other.ok) await aggregatorStore.updateStatus(other.value.id, 'active', 'admin');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, contact: { ...validBody.contact, phone: '+911111111111' } },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
  });

  it('rejects reclaim when the new phone is already held by a different KC user', async () => {
    const id = await seedPending(); // asha@trrain.org, phone +919876543210

    // Seed a DIFFERENT KC user that holds the target phone.
    await idp.createUser({
      email: 'other@x.org',
      phone: '+911234567890',
      attributes: { aggregator_id: 'other-agg', phoneNumber: '+911234567890' },
    });

    // Resubmit for email A but with the phone belonging to the other KC user.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, phone: '+911234567890' },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');

    // The reclaimed row must NOT have been mutated to the new phone.
    const stored = await aggregatorStore.findById(id);
    if (stored.ok && stored.value) {
      expect(stored.value.contact.phone).toBe('+919876543210');
    }
  });

  it('returns 503 when a KC write fails during reclaim', async () => {
    await seedPending();
    const originalSetDecision = idp.setUserDecision.bind(idp);
    idp.setUserDecision = async () => ({
      ok: false as const,
      error: { code: 'IDP_UNAVAILABLE' as const, message: 'kc down' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);

    idp.setUserDecision = originalSetDecision;
  });
});
