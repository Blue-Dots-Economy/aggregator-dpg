import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import {
  _setAggregatorProfileStore,
  AggregatorProfileStoreFake,
} from '../services/aggregator-profile-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { _resetTokenKey, mintApprovalToken } from '../services/approval-token.js';

const aggregatorId = '11111111-1111-1111-1111-111111111111';

describe('admin approval routes', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let kcUserId: string;

  beforeEach(async () => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.PUBLIC_API_URL = 'http://api.local';
    process.env.PUBLIC_PORTAL_URL = 'http://portal.local';

    aggregatorStore = new AggregatorStoreFake();
    aggregatorStore.seed([
      buildAggregator({
        id: aggregatorId,
        orgSlug: 'trrain-abcd',
        actorType: 'aggregator',
        type: null,
        name: 'TRRAIN',
        contact: {
          name: 'Asha Rao',
          phone: '+919876543210',
          email: 'asha@trrain.org',
        },
        status: 'pending',
      }),
    ]);
    _setAggregatorStore(aggregatorStore);
    _setAggregatorProfileStore(new AggregatorProfileStoreFake());

    idp = new IdpAdminFake();
    const created = await idp.createUser({
      email: 'asha@trrain.org',
      firstName: 'Asha',
      lastName: 'Rao',
      enabled: false,
      attributes: { aggregator_id: aggregatorId, decision_made: 'pending' },
    });
    if (!created.ok) throw new Error('seed failed');
    kcUserId = created.value.id;
    _setIdpAdmin(idp);

    mailer = new FakeMailer();
    _setMailer(mailer);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setAggregatorProfileStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
  });

  it('GET /read/:id renders the confirmation page when no decision yet', async () => {
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Approve aggregator application');
    expect(res.body).toContain('asha@trrain.org');
    expect(res.body).toContain(`/admin/v1/aggregator-registrations/decision/${aggregatorId}`);
  });

  it('GET /read/:id shows already-approved when aggregator.status=active', async () => {
    await aggregatorStore.updateStatus(aggregatorId, 'active', 'admin');
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Already approved');
  });

  it('GET /read/:id shows already-rejected when aggregator.status=inactive', async () => {
    await aggregatorStore.updateStatus(aggregatorId, 'inactive', 'admin');
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Already rejected');
  });

  it('GET /read/:id rejects malformed token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=junk&intent=approve`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid link');
  });

  it('GET /read/:id rejects token whose subject does not match the path id', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: '99999999-9999-9999-9999-999999999999',
      intent: 'approve',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/aggregator-registrations/read/${aggregatorId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /decision/:id approve flips DB status, enables KC user, stamps decision_made, emails applicant', async () => {
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application approved');

    const dbAfter = await aggregatorStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('active');
    }

    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(true);
      expect(after.value.attributes?.decision_made?.[0]).toBe('approved');
      // decided_at / rejection_reason attributes are no longer written to KC.
      expect(after.value.attributes?.decided_at).toBeUndefined();
    }

    expect(mailer.outbox).toHaveLength(1);
    const m = mailer.outbox[0];
    if (!m) throw new Error('no mail captured');
    expect(m.to).toBe('asha@trrain.org');
    expect(m.subject).toContain('approved');
  });

  it('POST /decision/:id reject flips DB status to inactive, keeps user disabled, emails applicant with reason', async () => {
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject', reason: 'incomplete documentation' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Application rejected');

    const dbAfter = await aggregatorStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('inactive');
    }

    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(false);
      expect(after.value.attributes?.decision_made?.[0]).toBe('rejected');
      // rejection_reason is no longer persisted on KC (audit-log only).
      expect(after.value.attributes?.rejection_reason).toBeUndefined();
    }

    expect(mailer.outbox).toHaveLength(1);
    const rejected = mailer.outbox[0];
    if (!rejected) throw new Error('no mail captured');
    expect(rejected.text).toContain('incomplete documentation');
  });

  it('POST /decision/:id approve is idempotent — second click does not re-send', async () => {
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Already approved');
    expect(mailer.outbox).toHaveLength(1);
  });

  it('POST /decision/:id reject is idempotent — second click does not re-send', async () => {
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'reject' });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject', reason: 'duplicate org' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'reject', reason: 'duplicate org' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Already rejected');
    expect(mailer.outbox).toHaveLength(1);
  });

  it('POST /decision/:id returns 400 when decision body is malformed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token: '', decision: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
  });
});
