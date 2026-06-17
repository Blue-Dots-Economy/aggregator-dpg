import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  RegistrationStoreFake,
  _setRegistrationStore,
  buildRegistration,
} from '../services/registration-store/index.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _resetTokenKey, mintVerificationToken } from '../services/approval-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';

describe('POST /v1/aggregator-registrations/:id/verify', () => {
  let app: FastifyInstance;
  let registrationStore: RegistrationStoreFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.ADMIN_EMAILS = 'admin@bluedots.local';

    registrationStore = new RegistrationStoreFake();
    mailer = new FakeMailer();

    _setRegistrationStore(registrationStore);
    _setMailer(mailer);
    _setAccessTokenVerifier(null);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setRegistrationStore(null);
    _setMailer(null);
  });

  async function mintToken(registrationId: string, ttlSec = 3600): Promise<string> {
    const { token } = await mintVerificationToken({ registrationId, ttlSec });
    return token;
  }

  it('transitions submitted → verified and notifies admins', async () => {
    const reg = buildRegistration({ state: 'submitted', version: 0 });
    registrationStore.seed([reg]);
    const token = await mintToken(reg.id);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/aggregator-registrations/${reg.id}/verify?token=${encodeURIComponent(token)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { verified: boolean };
    expect(body.verified).toBe(true);

    const loaded = await registrationStore.findById(reg.id);
    expect(loaded.ok && loaded.value?.state).toBe('verified');

    // Admin notification should have been sent best-effort.
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.to).toEqual(['admin@bluedots.local']);
  });

  it('is idempotent — already-verified registration returns 200 without re-notifying', async () => {
    const reg = buildRegistration({
      state: 'verified',
      provisionState: { admin_notify: 'done' },
    });
    registrationStore.seed([reg]);
    const token = await mintToken(reg.id);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/aggregator-registrations/${reg.id}/verify?token=${encodeURIComponent(token)}`,
    });

    expect(res.statusCode).toBe(200);
    // No new admin notification (row already verified, no transition attempted).
    expect(mailer.outbox).toHaveLength(0);
  });

  it('returns 400 when token is missing', async () => {
    const reg = buildRegistration({ state: 'submitted' });
    registrationStore.seed([reg]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/aggregator-registrations/${reg.id}/verify`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VERIFICATION_TOKEN_INVALID');
  });

  it('returns 400 for a malformed token', async () => {
    const reg = buildRegistration({ state: 'submitted' });
    registrationStore.seed([reg]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/aggregator-registrations/${reg.id}/verify?token=not-a-jwt`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VERIFICATION_TOKEN_INVALID');
  });

  it('returns 410 for an expired token', async () => {
    const reg = buildRegistration({ state: 'submitted' });
    registrationStore.seed([reg]);
    // TTL of 1 second — then we wait just a bit... actually tests are sync
    // so let's use ttlSec=-1 to get an already-expired token.
    const { token } = await mintVerificationToken({ registrationId: reg.id, ttlSec: -1 });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/aggregator-registrations/${reg.id}/verify?token=${encodeURIComponent(token)}`,
    });

    expect(res.statusCode).toBe(410);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VERIFICATION_TOKEN_EXPIRED');
  });

  it('returns 400 when token id does not match path id', async () => {
    const reg = buildRegistration({ state: 'submitted' });
    registrationStore.seed([reg]);
    const token = await mintToken('different-id-00000000000000000000');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/aggregator-registrations/${reg.id}/verify?token=${encodeURIComponent(token)}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VERIFICATION_TOKEN_INVALID');
  });

  it('returns 404 when registration does not exist', async () => {
    const token = await mintToken('nonexistent-reg-id-00000000000000');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/aggregator-registrations/nonexistent-reg-id-00000000000000/verify?token=${encodeURIComponent(token)}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('still returns 200 when admin notify fails (best-effort)', async () => {
    const reg = buildRegistration({ state: 'submitted', version: 0 });
    registrationStore.seed([reg]);
    const token = await mintToken(reg.id);

    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/aggregator-registrations/${reg.id}/verify?token=${encodeURIComponent(token)}`,
    });

    // Transition still succeeds; mailer failure must not be a 5xx.
    expect(res.statusCode).toBe(200);
    const loaded = await registrationStore.findById(reg.id);
    expect(loaded.ok && loaded.value?.state).toBe('verified');
  });
});
