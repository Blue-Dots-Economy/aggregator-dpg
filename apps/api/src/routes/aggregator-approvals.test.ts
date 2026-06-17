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
import { _resetTokenKey, mintRegistrationApprovalToken } from '../services/approval-token.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import {
  RegistrationStoreFake,
  _setRegistrationStore,
  buildRegistration,
} from '../services/registration-store/index.js';

const regId = '11111111-1111-1111-1111-111111111111';

describe('admin approval routes (FSM)', () => {
  let app: FastifyInstance;
  let registrationStore: RegistrationStoreFake;
  let aggregatorStore: AggregatorStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.PUBLIC_API_URL = 'http://api.local';
    process.env.PUBLIC_PORTAL_URL = 'http://portal.local';
    process.env.ADMIN_EMAILS = 'admin@bluedots.local';

    registrationStore = new RegistrationStoreFake();
    aggregatorStore = new AggregatorStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    _setRegistrationStore(registrationStore);
    _setAggregatorStore(aggregatorStore);
    _setAggregatorProfileStore(new AggregatorProfileStoreFake());
    _setIdpAdmin(idp);
    _setMailer(mailer);
    // Disable signalstack in most tests; enable selectively.
    _setSignalStackWriter(null);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setRegistrationStore(null);
    _setAggregatorStore(null);
    _setAggregatorProfileStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setSignalStackWriter(null);
  });

  async function mintToken(intent: 'approve' | 'reject', id = regId): Promise<string> {
    const { token } = await mintRegistrationApprovalToken({ registrationId: id, intent });
    return token;
  }

  // ── GET confirm page ─────────────────────────────────────────────────────────

  describe('GET /admin/v1/aggregator-registrations/read/:id', () => {
    it('renders confirm page for verified registration', async () => {
      registrationStore.seed([buildRegistration({ id: regId, state: 'verified' })]);
      const token = await mintToken('approve');

      const res = await app.inject({
        method: 'GET',
        url: `/admin/v1/aggregator-registrations/read/${regId}?token=${encodeURIComponent(token)}&intent=approve`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('approve');
    });

    it('returns already-decided page when registration is already active', async () => {
      registrationStore.seed([
        buildRegistration({ id: regId, state: 'active', aggregatorId: 'agg-1' }),
      ]);
      const token = await mintToken('approve');

      const res = await app.inject({
        method: 'GET',
        url: `/admin/v1/aggregator-registrations/read/${regId}?token=${encodeURIComponent(token)}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Already approved');
    });

    it('returns 400 when token is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v1/aggregator-registrations/read/${regId}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v1/aggregator-registrations/read/${regId}?token=not-a-jwt`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when registration does not exist', async () => {
      const token = await mintToken('approve');
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v1/aggregator-registrations/read/${regId}?token=${encodeURIComponent(token)}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── POST decision ────────────────────────────────────────────────────────────

  describe('POST /admin/v1/aggregator-registrations/decision/:id', () => {
    it('approve: transitions verified → approved and kicks provisioning', async () => {
      registrationStore.seed([buildRegistration({ id: regId, state: 'verified', version: 0 })]);
      const token = await mintToken('approve');

      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${regId}`,
        payload: { token, decision: 'approve' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('approved');

      // After inline provisioning completes (async void), state should be active.
      // Give the microtask queue a tick to settle.
      await new Promise((r) => setTimeout(r, 50));
      const loaded = await registrationStore.findById(regId);
      expect(loaded.ok && loaded.value?.state).toBe('active');
    });

    it('reject: transitions verified → rejected and sends rejection email', async () => {
      registrationStore.seed([buildRegistration({ id: regId, state: 'verified', version: 0 })]);
      const token = await mintToken('reject');

      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${regId}`,
        payload: { token, decision: 'reject', reason: 'Does not meet criteria.' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('rejected');

      await new Promise((r) => setTimeout(r, 50));
      const loaded = await registrationStore.findById(regId);
      expect(loaded.ok && loaded.value?.state).toBe('rejected');

      // Rejection email should have been sent best-effort.
      expect(mailer.outbox.length).toBeGreaterThanOrEqual(1);
    });

    it('concurrent approve returns already-decided page (STALE_TRANSITION)', async () => {
      // Seed in verified state.
      const reg = buildRegistration({ id: regId, state: 'verified', version: 0 });
      registrationStore.seed([reg]);
      const token = await mintToken('approve');

      // First approve transitions the row.
      await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${regId}`,
        payload: { token, decision: 'approve' },
      });

      // Second approve with the same token gets STALE_TRANSITION (version mismatch).
      const res2 = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${regId}`,
        payload: { token, decision: 'approve' },
      });

      expect(res2.statusCode).toBe(200);
      expect(res2.body).toContain('Already approved');
    });

    it('returns already-decided page when registration is already active', async () => {
      registrationStore.seed([
        buildRegistration({ id: regId, state: 'active', aggregatorId: 'agg-1' }),
      ]);
      const token = await mintToken('approve');

      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${regId}`,
        payload: { token, decision: 'approve' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Already approved');
    });

    it('returns 400 for invalid token', async () => {
      registrationStore.seed([buildRegistration({ id: regId, state: 'verified' })]);

      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${regId}`,
        payload: { token: 'not-a-jwt', decision: 'approve' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 409 when registration is not in verified state', async () => {
      registrationStore.seed([buildRegistration({ id: regId, state: 'submitted', version: 0 })]);
      const token = await mintToken('approve');

      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${regId}`,
        payload: { token, decision: 'approve' },
      });

      expect(res.statusCode).toBe(409);
    });
  });
});
