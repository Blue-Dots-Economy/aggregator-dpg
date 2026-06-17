import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  RegistrationStoreFake,
  _setRegistrationStore,
  buildRegistration,
} from '../services/registration-store/index.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _resetTokenKey } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };

describe('POST /v1/aggregator-registrations/create', () => {
  let app: FastifyInstance;
  let registrationStore: RegistrationStoreFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    registrationStore = new RegistrationStoreFake();
    mailer = new FakeMailer();

    _setRegistrationStore(registrationStore);
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
    _setRegistrationStore(null);
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

  it('returns 202 and sends a verification email on valid payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { message: string };
    expect(body.message).toContain('verify');

    // A verification email should have been dispatched best-effort.
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.to).toBe('asha@trrain.org');
    expect(mailer.outbox[0]!.subject).toContain('Verify');

    // A registrations row should exist.
    const rows = await registrationStore.listNonTerminal();
    expect(rows.ok && rows.value).toHaveLength(1);
    expect(rows.ok && rows.value[0]?.state).toBe('submitted');
    expect(rows.ok && rows.value[0]?.contactEmail).toBe('asha@trrain.org');
  });

  it('replays 202 on second identical submit (idempotent)', async () => {
    // First submit creates the row.
    await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });

    // Second submit with the same data should replay without creating a second row.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });

    expect(res.statusCode).toBe(202);
    const rows = await registrationStore.listNonTerminal();
    expect(rows.ok && rows.value).toHaveLength(1);
    // No second email should be sent (idempotency replay, cooldown not elapsed).
    expect(mailer.outbox).toHaveLength(1);
  });

  it('returns 202 silently when email is already taken (no existence oracle)', async () => {
    // Seed an existing row with the same email but a different idempotency key.
    registrationStore.seed([
      buildRegistration({
        id: 'existing-reg-001',
        idempotencyKey: 'different-key',
        contactEmail: 'asha@trrain.org',
        contactPhone: '+919999999999',
      }),
    ]);

    // Submit with same email but different phone (different fingerprint → new
    // key → hits DUPLICATE_EMAIL inside store.create).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: {
        ...validBody,
        contact: { ...validBody.contact, phone: '+919111111111' },
      },
    });

    // Must be 202 — no existence oracle.
    expect(res.statusCode).toBe(202);
    // No email to the applicant (we don't send to a different row's address).
    expect(mailer.outbox).toHaveLength(0);
  });

  it('returns 202 even when verification email send fails (best-effort)', async () => {
    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });

    // The row was created; the email failure must not surface as a 5xx.
    expect(res.statusCode).toBe(202);
    const rows = await registrationStore.listNonTerminal();
    expect(rows.ok && rows.value).toHaveLength(1);
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

  it('returns 400 when required fields are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; title: string; requestId: string } };
    expect(body.error.code).toBe('SCHEMA_VALIDATION');
    expect(body.error.requestId).toMatch(/^req-/);
  });

  it('returns 400 for a malformed email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, contact: { ...validBody.contact, email: 'not-an-email' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid phone number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: { ...validBody, contact: { ...validBody.contact, phone: 'not-a-phone' } },
    });
    // 400 regardless of whether Zod/JSON schema or normalisePhone rejects first.
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when the registration store is unavailable', async () => {
    // Monkey-patch findByIdempotencyKey to simulate DB failure.
    const origFind = registrationStore.findByIdempotencyKey.bind(registrationStore);
    registrationStore.findByIdempotencyKey = async () => ({
      ok: false as const,
      error: { code: 'DB_UNAVAILABLE' as const, message: 'postgres down' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload: validBody,
    });

    expect(res.statusCode).toBe(503);
    registrationStore.findByIdempotencyKey = origFind;
  });
});
