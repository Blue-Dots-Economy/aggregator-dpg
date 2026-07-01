// Flag-gated routes; set the flag before any import that pulls in `config`.
process.env.ORG_HIERARCHY_ENABLED = 'true';

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorOrgStoreFake,
  buildAggregatorOrg,
  _setAggregatorOrgStore,
} from '../services/aggregator-org-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '../services/mailer/index.js';
import { mintApprovalToken, _resetTokenKey } from '../services/approval-token.js';
import { _resetJwks } from '../services/auth/access-token.js';

describe('aggregator-org-approvals routes', () => {
  let app: FastifyInstance;
  let orgStore: AggregatorOrgStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  beforeEach(async () => {
    _resetTokenKey();
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';

    orgStore = new AggregatorOrgStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    _setAggregatorOrgStore(orgStore);
    _setIdpAdmin(idp);
    _setMailer(mailer);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorOrgStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
  });

  it('approve flips org to active via atomic CAS and enables the owner', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a1';
    const owner = await idp.createUser({
      email: 'owner@x.org',
      enabled: false,
      attributes: { decision_made: 'pending' },
    });
    if (!owner.ok) throw new Error('seed');
    orgStore.seed([
      buildAggregatorOrg({
        id: orgId,
        slug: 'x',
        ownerEmail: 'owner@x.org',
        ownerKcSub: owner.value.id,
        kcGroupId: 'grp-1',
        status: 'pending',
      }),
    ]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const stored = await orgStore.findById(orgId);
    expect(stored.ok && stored.value?.status).toBe('active');
    const kc = await idp.findById(owner.value.id);
    expect(kc.ok && kc.value?.enabled).toBe(true);
    expect(idp.rolesOf(owner.value.id)).toContain('org_owner');
  });

  it('double-clicked approve commits once (atomic single-use guard)', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a2';
    const owner = await idp.createUser({ email: 'o2@x.org', enabled: false });
    if (!owner.ok) throw new Error('seed');
    orgStore.seed([
      buildAggregatorOrg({
        id: orgId,
        slug: 'y',
        ownerEmail: 'o2@x.org',
        ownerKcSub: owner.value.id,
        status: 'pending',
      }),
    ]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const first = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'approve' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'approve' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('already');
  });

  it('reject sets the org inactive', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a3';
    orgStore.seed([buildAggregatorOrg({ id: orgId, slug: 'z', status: 'pending' })]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'reject' });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/decision/${orgId}`,
      payload: { token, decision: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    const stored = await orgStore.findById(orgId);
    expect(stored.ok && stored.value?.status).toBe('inactive');
  });

  it('GET read page renders the confirm page for a pending org', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a4';
    orgStore.seed([
      buildAggregatorOrg({ id: orgId, slug: 'w', displayName: 'Wonder Org', status: 'pending' }),
    ]);
    const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/orgs/read/${orgId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Wonder Org');
  });

  it('GET read page with an expired token shows a resend action (§7)', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a5';
    orgStore.seed([buildAggregatorOrg({ id: orgId, slug: 'ex', status: 'pending' })]);
    const { token } = await mintApprovalToken({
      aggregatorId: orgId,
      intent: 'approve',
      ttlSec: -1,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/v1/orgs/read/${orgId}?token=${encodeURIComponent(token)}&intent=approve`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Link expired');
    expect(res.body).toContain('Resend approval link');
    expect(res.body).toContain(`/admin/v1/orgs/resend/${orgId}`);
  });

  it('POST resend re-sends the review email for a pending org using an expired token', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a6';
    orgStore.seed([
      buildAggregatorOrg({ id: orgId, slug: 'rs', ownerEmail: 'o@x.org', status: 'pending' }),
    ]);
    const { token } = await mintApprovalToken({
      aggregatorId: orgId,
      intent: 'approve',
      ttlSec: -1,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/resend/${orgId}`,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Approval link sent');
    expect(mailer.outbox.length).toBe(1);
  });

  it('POST resend on an already-approved org is a no-op', async () => {
    const orgId = '00000000-0000-0000-0000-0000000000a7';
    orgStore.seed([buildAggregatorOrg({ id: orgId, slug: 'done', status: 'active' })]);
    const { token } = await mintApprovalToken({
      aggregatorId: orgId,
      intent: 'approve',
      ttlSec: -1,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/v1/orgs/resend/${orgId}`,
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Already approved');
    expect(mailer.outbox.length).toBe(0);
  });
});
