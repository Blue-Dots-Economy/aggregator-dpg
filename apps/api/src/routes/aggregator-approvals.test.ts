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
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { SignalStackWriterBase } from '@aggregator-dpg/signalstack-writer/interface';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';

const aggregatorId = '11111111-1111-1111-1111-111111111111';

describe('admin approval routes', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let signalstack: SignalStackWriterFake;
  let kcUserId: string;

  beforeEach(async () => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.PUBLIC_API_URL = 'http://api.local';
    process.env.PUBLIC_PORTAL_URL = 'http://portal.local';
    // Treat signalstack as enabled so the approval route hits our fake.
    process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
    process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
    process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';

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

    signalstack = new SignalStackWriterFake();
    _setSignalStackWriter(signalstack);

    // Approval flow now reads cfg.domainIds from the network config —
    // pin a blue_dot-shaped config so the legacy `['seeker','provider']`
    // assertions in this file still hold.
    _setNetworkConfig(buildBlueDotConfig());

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setAggregatorProfileStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
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
    expect(dbAfter.ok).toBe(true);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('active');
      // signalstack_org_id is mirrored from the upsert response onto the
      // aggregators row so worker + anonymous link submission paths can
      // read it without touching Keycloak.
      expect(dbAfter.value.signalstackOrgId).toBeDefined();
      expect(dbAfter.value.signalstackOrgId).not.toBeNull();
    }

    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(true);
      expect(after.value.attributes?.decision_made?.[0]).toBe('approved');
      // decided_at / rejection_reason attributes are no longer written to KC.
      expect(after.value.attributes?.decided_at).toBeUndefined();
      // signalstack_org_id is written from the upsert response on approval.
      const orgIdAttr = after.value.attributes?.signalstack_org_id?.[0];
      expect(orgIdAttr).toBeDefined();
      const aggregators = signalstack.listAggregators();
      expect(aggregators).toHaveLength(1);
      expect(aggregators[0]?.external_id).toBe(aggregatorId);
      expect(aggregators[0]?.name).toBe('TRRAIN');
      expect(aggregators[0]?.slug).toBe('trrain-abcd');
      expect(orgIdAttr).toBe(aggregators[0]?.org_id);
      // KC attr and DB mirror must agree.
      if (dbAfter.ok && dbAfter.value) {
        expect(dbAfter.value.signalstackOrgId).toBe(orgIdAttr);
      }
    }

    expect(mailer.outbox).toHaveLength(1);
    const m = mailer.outbox[0];
    if (!m) throw new Error('no mail captured');
    expect(m.to).toBe('asha@trrain.org');
    expect(m.subject).toContain('approved');
  });

  it('POST /decision/:id approve aborts with 503 when signalstack upsert fails — DB stays pending, KC user stays disabled', async () => {
    // Hard-gate policy: signalstack upsert is step 1 of approval. If it
    // fails, the route returns 503 without touching DB status or KC user
    // state, so the admin can re-click the approval link once signalstack
    // is reachable again. Single-use guard reads DB status (still pending)
    // and the upsert is idempotent on external_id, so retry is clean.
    class FailingUpsertWriter extends SignalStackWriterBase {
      async onboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async listItemsByAggregator() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async upsertAggregator() {
        return err(
          new UpstreamError('signalstack upsert returned 503', {
            code: 'SIGNALSTACK_SERVER_ERROR',
          }),
        );
      }
      async fetchDashboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async exportDashboardCsv() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async fetchDecryptedProfiles() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async probeUser() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async getItem() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
    }
    _setSignalStackWriter(new FailingUpsertWriter());

    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('Action failed');

    // KC user remains disabled — login still blocked. `decision_made` stays
    // at the registration-time default of 'pending'.
    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(false);
      expect(after.value.attributes?.decision_made?.[0]).toBe('pending');
      expect(after.value.attributes?.signalstack_org_id).toBeUndefined();
    }
    // DB status stays pending — admin can re-click to retry.
    const dbAfter = await aggregatorStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('pending');
      expect(dbAfter.value.signalstackOrgId).toBeNull();
    }
  });

  it('POST /decision/:id approve aborts with 503 when KC enableUser fails — DB stays pending, signalstack idempotent on retry', async () => {
    // Step 2 (idp.enableUser) failure path: signalstack already wrote
    // (step 1 succeeded), but KC is unreachable. DB status must stay
    // pending so admin can re-click. signalstack.upsertAggregator is
    // idempotent on external_id, so the retry second call returns the
    // same orgId.
    const originalEnable = idp.enableUser.bind(idp);
    let enableCalls = 0;
    idp.enableUser = async (id: string) => {
      enableCalls++;
      if (enableCalls === 1) {
        return { ok: false, error: { code: 'IDP_UNAVAILABLE', message: 'KC unreachable' } };
      }
      return originalEnable(id);
    };

    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });

    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(503);
    expect(first.body).toContain('Identity service unavailable');

    // KC user still disabled; DB still pending.
    const afterFirst = await idp.findById(kcUserId);
    if (afterFirst.ok && afterFirst.value) {
      expect(afterFirst.value.enabled).toBe(false);
    }
    const dbAfterFirst = await aggregatorStore.findById(aggregatorId);
    if (dbAfterFirst.ok && dbAfterFirst.value) {
      expect(dbAfterFirst.value.status).toBe('pending');
    }

    // Retry — KC now responsive. Approval completes; signalstack returns
    // same orgId via the in-memory fake's idempotency on external_id.
    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Application approved');

    const dbAfter = await aggregatorStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('active');
      expect(dbAfter.value.signalstackOrgId).not.toBeNull();
    }
    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(true);
    }
    // Signalstack idempotency: upsert was called twice, both with same
    // external_id, returning the same org row.
    const aggregators = signalstack.listAggregators();
    expect(aggregators).toHaveLength(1);
  });

  it('POST /decision/:id approve succeeds on retry after signalstack recovers', async () => {
    // First click: signalstack down → 503, no state change.
    class FailingUpsertWriter extends SignalStackWriterBase {
      async onboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async listItemsByAggregator() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async upsertAggregator() {
        return err(new UpstreamError('down', { code: 'SIGNALSTACK_SERVER_ERROR' }));
      }
      async fetchDashboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async exportDashboardCsv() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async fetchDecryptedProfiles() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async probeUser() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async getItem() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
    }
    _setSignalStackWriter(new FailingUpsertWriter());
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(503);

    // Second click: signalstack reachable — approval completes.
    _setSignalStackWriter(signalstack);
    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Application approved');

    const dbAfter = await aggregatorStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.status).toBe('active');
      expect(dbAfter.value.signalstackOrgId).not.toBeNull();
    }
    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.enabled).toBe(true);
    }
  });

  it('POST /decision/:id approve skips upsert cleanly when signalstack writer is disabled', async () => {
    _setSignalStackWriter(null);
    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);

    const after = await idp.findById(kcUserId);
    if (after.ok && after.value) {
      expect(after.value.attributes?.signalstack_org_id).toBeUndefined();
    }
    const dbAfter = await aggregatorStore.findById(aggregatorId);
    if (dbAfter.ok && dbAfter.value) {
      expect(dbAfter.value.signalstackOrgId).toBeNull();
    }
  });

  // Capturing writer factory — records every upsertAggregator input so
  // domain-restriction tests can assert what the approval flow dispatched
  // without depending on the in-memory fake's internals.
  const buildCapturingWriter = (
    captured: Array<{ external_id: string; domains: string[] | undefined }>,
    orgIdSeed: string,
  ) =>
    new (class extends SignalStackWriterBase {
      async onboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async listItemsByAggregator() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async upsertAggregator(input: { external_id: string; domains?: string[] | undefined }) {
        captured.push({ external_id: input.external_id, domains: input.domains });
        return ok({
          org_id: orgIdSeed,
          external_id: input.external_id,
          name: 'TRRAIN',
          slug: 'trrain-abcd',
        });
      }
      async fetchDashboard() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async exportDashboardCsv() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async fetchDecryptedProfiles() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async probeUser() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
      async getItem() {
        return err(new UpstreamError('not used', { code: 'X' }));
      }
    })();

  const seedAggregatorWithType = (type: string | null) => {
    aggregatorStore.seed([
      buildAggregator({
        id: aggregatorId,
        orgSlug: 'trrain-abcd',
        actorType: 'aggregator',
        type,
        name: 'TRRAIN',
        contact: { name: 'Asha Rao', phone: '+919876543210', email: 'asha@trrain.org' },
        status: 'pending',
      }),
    ]);
  };

  it.each([
    ['seeker', ['seeker']],
    ['provider', ['provider']],
  ])(
    'POST /decision/:id approve forwards only `%s` to signalstack domains',
    async (type, expectedDomains) => {
      seedAggregatorWithType(type);
      const captured: Array<{ external_id: string; domains: string[] | undefined }> = [];
      _setSignalStackWriter(buildCapturingWriter(captured, `mem-org-${type}`));

      const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
      const res = await app.inject({
        method: 'POST',
        url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
        payload: { token, decision: 'approve' },
      });
      expect(res.statusCode).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.domains).toEqual(expectedDomains);
    },
  );

  it('POST /decision/:id approve falls back to both domains when aggregator.type is null (legacy)', async () => {
    // Default seed uses type: null. Capture upsert + assert the
    // legacy fallback list goes out.
    const captured: Array<{ external_id: string; domains: string[] | undefined }> = [];
    _setSignalStackWriter(buildCapturingWriter(captured, 'mem-org-legacy'));

    const { token } = await mintApprovalToken({ aggregatorId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(captured[0]?.domains).toEqual(['seeker', 'provider']);
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
