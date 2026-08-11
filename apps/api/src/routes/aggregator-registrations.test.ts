import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
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
} from '../services/aggregator-profile-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type * as ConfigLoaderFs from '@aggregator-dpg/config-loader/fs';

const { loadConsentConfigMock } = vi.hoisted(() => ({ loadConsentConfigMock: vi.fn() }));
vi.mock('@aggregator-dpg/config-loader/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigLoaderFs>();
  return { ...actual, loadConsentConfig: loadConsentConfigMock };
});

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('POST /v1/aggregator-registrations/create', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let profileStore: AggregatorProfileStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let consentLedger: ConsentLedgerFake;

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
    consentLedger = new ConsentLedgerFake();

    loadConsentConfigMock.mockReset();
    const actualLoader = await vi.importActual<typeof ConfigLoaderFs>(
      '@aggregator-dpg/config-loader/fs',
    );
    loadConsentConfigMock.mockImplementation(actualLoader.loadConsentConfig);

    _setAggregatorStore(aggregatorStore);
    _setAggregatorProfileStore(profileStore);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setConsentLedger(consentLedger);
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
    _setConsentLedger(null);
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

    // Consent ledger should have one row for the aggregator
    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    const consentRow = ledgerRows[0];
    expect(consentRow?.subjectType).toBe('aggregator');
    expect(consentRow?.subjectId).toBe(body.aggregator_id);
    expect(consentRow?.termsVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.privacyVersion).toBeGreaterThanOrEqual(1);
    expect(consentRow?.source).toBe('registration');
    // network/brand must come from AGGREGATOR_NETWORK/AGGREGATOR_BRAND (not a
    // different config var) so the recorded version matches what the web layer displayed.
    expect(consentRow?.network).toBe('blue_dot'); // default when AGGREGATOR_NETWORK unset
    expect(consentRow?.brand).toBeNull(); // default when AGGREGATOR_BRAND unset
  });

  it('records aggregator consent in the ledger on successful registration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const { aggregator_id } = res.json() as { aggregator_id: string };

    const ledgerRows = consentLedger.list();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.subjectType).toBe('aggregator');
    expect(ledgerRows[0]?.subjectId).toBe(aggregator_id);
  });

  it('records the resolved AGGREGATOR_NETWORK and AGGREGATOR_BRAND in the consent ledger', async () => {
    process.env.AGGREGATOR_NETWORK = 'orange_dot';
    process.env.AGGREGATOR_BRAND = 'onetac';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/aggregator-registrations/create',
        headers: AUTH_HEADER,
        payload: {
          ...validBody,
          contact: { ...validBody.contact, email: 'brand@test.org', phone: '+919999999999' },
        },
      });
      expect(res.statusCode).toBe(201);
      const ledgerRows = consentLedger.list();
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.network).toBe('orange_dot');
      expect(ledgerRows[0]?.brand).toBe('onetac');
    } finally {
      delete process.env.AGGREGATOR_NETWORK;
      delete process.env.AGGREGATOR_BRAND;
    }
  });

  it('fails registration (fail-closed) when the consent ledger write fails', async () => {
    // Make the ledger always return an error
    consentLedger.recordRegistrationConsent = async () => ({
      success: false as const,
      error: Object.assign(new Error('ledger down'), {
        name: 'UpstreamError',
        code: 'CONSENT_INSERT_FAILED',
      }) as BaseError,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, contact: { ...validBody.contact, email: 'ledger-fail@trrain.org' } },
    });
    // Fail-closed: no consent recorded → the registration is rolled back, not 201.
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('CONSENT_WRITE_FAILED');
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

  it('returns 409 for a rejected (inactive) registration on resubmit (recover via prune)', async () => {
    const id = await seedPending({ status: 'inactive' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    // Rejected records are not reclaimable — re-registration only after the
    // stale-prune job clears the old row.
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
    const stored = await aggregatorStore.findById(id);
    if (stored.ok) expect(stored.value?.status).toBe('inactive');
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

  it('re-mint on a pending record does NOT overwrite the on-file identity (no takeover)', async () => {
    const id = await seedPending(); // asha@trrain.org / +919876543210, pending
    // A stranger resubmits the victim's email with their OWN phone + name.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        name: 'Attacker Org',
        contact: { ...validBody.contact, name: 'Attacker', phone: '+919999999999' },
      },
    });
    expect(res.statusCode).toBe(200);
    // The on-file record is unchanged — the submitted phone/name are ignored.
    const stored = await aggregatorStore.findById(id);
    if (stored.ok && stored.value) {
      expect(stored.value.contact.phone).toBe('+919876543210');
      expect(stored.value.name).toBe('TRRAIN');
    }
    // KC OTP identity (phoneNumber) is unchanged too.
    const kc = await idp.findByEmail('asha@trrain.org');
    if (kc.ok && kc.value) {
      expect(kc.value.attributes?.phoneNumber?.[0]).toBe('+919876543210');
    }
    // The review link was re-sent (to the reviewer, not the caller).
    expect(mailer.outbox.length).toBe(1);
  });

  it('400 SCHEMA_VALIDATION when `type` is not a domain declared by the active network (Ajv)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, type: 'not-a-real-domain' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SCHEMA_VALIDATION');
  });

  it('503 DB_UNAVAILABLE when findByContactEmail fails', async () => {
    aggregatorStore.findByContactEmail = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('503 DB_UNAVAILABLE when findByContactPhone fails', async () => {
    aggregatorStore.findByContactPhone = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });

  it('409 PHONE_EXISTS when the phone already exists in the DB (no matching KC user)', async () => {
    // A prior aggregator row already holds this phone (e.g. KC user was
    // separately cleaned up but the DB row remains) — the DB-level phone
    // uniqueness check must still catch it before any KC calls happen.
    aggregatorStore.seed([
      buildAggregator({
        id: '33333333-3333-3333-3333-333333333333',
        orgSlug: 'other-org',
        contact: { name: 'Other', phone: '+919876543210', email: 'other@other.org' },
        status: 'pending',
      }),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody, // same phone +919876543210, different email
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
  });

  it('503 IDP_UNAVAILABLE when idp.findByEmail fails', async () => {
    idp.findByEmail = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
  });

  it('503 IDP_UNAVAILABLE when idp.findByAttribute(phoneNumber) fails', async () => {
    idp.findByAttribute = async () => ({
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'kc down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('IDP_UNAVAILABLE');
  });

  it.each([
    ['DUPLICATE_SLUG', 503, 'DUPLICATE_SLUG'],
    ['DUPLICATE_PHONE', 409, 'PHONE_EXISTS'],
    ['DUPLICATE_EMAIL', 409, 'USER_EXISTS'],
    ['CHECK_VIOLATION', 400, 'SCHEMA_VALIDATION'],
    ['DB_UNAVAILABLE', 503, 'DB_UNAVAILABLE'],
    ['NOT_FOUND', 503, 'DB_UNAVAILABLE'],
  ] as const)(
    'maps aggregatorStore.create error %s to %d %s',
    async (storeCode, status, errCode) => {
      aggregatorStore.create = async () => ({
        ok: false,
        error: { code: storeCode, message: 'store error' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/aggregator-registrations/create',
        headers: AUTH_HEADER,
        payload: validBody,
      });
      expect(res.statusCode).toBe(status);
      expect((res.json() as { error: { code: string } }).error.code).toBe(errCode);
    },
  );

  it('500 CONSENT_WRITE_FAILED (rolled back) when the consent config fails to load', async () => {
    loadConsentConfigMock.mockRejectedValueOnce(new Error('disk error'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'consent-fail@trrain.org' },
      },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_WRITE_FAILED');
    const found = await aggregatorStore.findByContactEmail('consent-fail@trrain.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('503 DB_UNAVAILABLE (rolled back) when profileStore.create fails', async () => {
    profileStore.create = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'db down' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'profile-fail@trrain.org' },
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
    const found = await aggregatorStore.findByContactEmail('profile-fail@trrain.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('409 USER_EXISTS (rolled back) when idp.createUser races to USER_EXISTS after the pre-check passed', async () => {
    idp.createUser = async () => ({
      ok: false,
      error: { code: 'USER_EXISTS', message: 'race: user created concurrently' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, contact: { ...validBody.contact, email: 'race@trrain.org' } },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
    const found = await aggregatorStore.findByContactEmail('race@trrain.org');
    expect(found.ok && found.value).toBeNull();
  });

  it('clamps a consent valid_till far beyond the max validity window to the server ceiling', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, email: 'long-consent@trrain.org' },
        consent: {
          value: true,
          given_at: '2026-01-15T10:00:00Z',
          valid_till: '2099-01-15T10:00:00Z',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { aggregator_id } = res.json() as { aggregator_id: string };
    const stored = await aggregatorStore.findById(aggregator_id);
    if (stored.ok && stored.value) {
      const validTill = new Date(stored.value.consent.valid_till).getTime();
      const now = Date.now();
      const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000;
      // Clamped well under the requested 2099 date, at ~5 years from now.
      expect(validTill).toBeLessThan(now + fiveYearsMs + 60_000);
      expect(validTill).toBeGreaterThan(now + fiveYearsMs - 60_000);
    }
  });
});
