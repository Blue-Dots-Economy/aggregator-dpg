// Coordinator submit with an invite token (#700). Flag must be set before any
// import that pulls in `config`.
process.env.ORG_HIERARCHY_ENABLED = 'true';

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { AggregatorStoreFake, _setAggregatorStore } from '../services/aggregator-store/index.js';
import {
  AggregatorProfileStoreFake,
  _setAggregatorProfileStore,
} from '../services/aggregator-profile-store/index.js';
import {
  AggregatorOrgStoreFake,
  buildAggregatorOrg,
  _setAggregatorOrgStore,
} from '../services/aggregator-org-store/index.js';
import {
  RegistrationInvitesStoreFake,
  buildRegistrationInvite,
  _setRegistrationInvitesStore,
} from '../services/registration-invites-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _resetTokenKey } from '../services/approval-token.js';
import { mintInviteToken, _resetInviteTokenKey } from '../services/invite-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSubmitRateChecker } from '../services/submit-rate.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';

const SERVICE_BEARER = 'service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_BEARER}` };
const ORG_ID = '00000000-0000-0000-0000-0000000000c1';
const INVITE_EMAIL = 'asha@trrain.org';

describe('coordinator submit with an invite token (#700)', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let orgStore: AggregatorOrgStoreFake;
  let invites: RegistrationInvitesStoreFake;

  const validBody = {
    name: 'TRRAIN',
    type: 'seeker',
    contact: { name: 'Asha Kumari', phone: '+919876543210', email: INVITE_EMAIL },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2027-01-15T10:00:00Z' },
  };

  /** Seed a pending invite for (ORG_ID, INVITE_EMAIL) and mint a token for it. */
  async function seedInviteAndToken(
    overrides: Parameters<typeof buildRegistrationInvite>[0] = {},
  ): Promise<string> {
    const invite = buildRegistrationInvite({
      jti: 'inv-1',
      parentOrgId: ORG_ID,
      email: INVITE_EMAIL,
      status: 'pending',
      ...overrides,
    });
    invites.seed([invite]);
    const { token } = await mintInviteToken({
      jti: invite.jti,
      org: invite.parentOrgId,
      email: invite.email,
    });
    return token;
  }

  beforeEach(async () => {
    _resetTokenKey();
    _resetInviteTokenKey();
    _resetJwks();
    _setSubmitRateChecker(null);
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    aggregatorStore = new AggregatorStoreFake();
    orgStore = new AggregatorOrgStoreFake();
    invites = new RegistrationInvitesStoreFake();

    _setAggregatorStore(aggregatorStore);
    _setAggregatorProfileStore(new AggregatorProfileStoreFake());
    _setAggregatorOrgStore(orgStore);
    _setRegistrationInvitesStore(invites);
    _setIdpAdmin(new IdpAdminFake());
    _setMailer(new FakeMailer());
    _setConsentLedger(new ConsentLedgerFake());
    _setAccessTokenVerifier(async (token) => {
      if (token === SERVICE_BEARER) {
        return { sub: 'service-account-aggregator-bff', azp: 'aggregator-bff' };
      }
      throw new Error('invalid token');
    });
    orgStore.seed([
      buildAggregatorOrg({ id: ORG_ID, slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
    ]);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setAggregatorProfileStore(null);
    _setAggregatorOrgStore(null);
    _setRegistrationInvitesStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setAccessTokenVerifier(null);
    _setSubmitRateChecker(null);
    _setConsentLedger(null);
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/aggregator-registrations/create',
      headers: AUTH_HEADER,
      payload,
    });
  }

  it('accepts a valid invite: stamps parent_org_id from the claim and consumes the invite', async () => {
    const token = await seedInviteAndToken();
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { aggregator_id: string }).aggregator_id;
    const stored = await aggregatorStore.findById(id);
    expect(stored.ok && stored.value?.parentOrgId).toBe(ORG_ID);
    // Invite is now consumed (single-use).
    const inv = await invites.findByJti('inv-1');
    expect(inv.ok && inv.value?.status).toBe('consumed');
  });

  it('rejects a submitted email that does not match the invite (403)', async () => {
    const token = await seedInviteAndToken();
    const res = await post({
      ...validBody,
      contact: { ...validBody.contact, email: 'someone-else@trrain.org' },
      invite: token,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVITE_EMAIL_MISMATCH');
  });

  it('rejects an expired invite (410)', async () => {
    invites.seed([
      buildRegistrationInvite({ jti: 'inv-1', parentOrgId: ORG_ID, email: INVITE_EMAIL }),
    ]);
    const { token } = await mintInviteToken({
      jti: 'inv-1',
      org: ORG_ID,
      email: INVITE_EMAIL,
      ttlSec: -1,
    });
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVITE_EXPIRED');
  });

  it('rejects a tampered/invalid token (400)', async () => {
    const token = await seedInviteAndToken();
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2]!.length)}`;
    const res = await post({ ...validBody, invite: tampered });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVITE_INVALID');
  });

  it('rejects an invite whose row is no longer pending (409)', async () => {
    const token = await seedInviteAndToken({ status: 'revoked' });
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVITE_ALREADY_USED');
  });

  it('rejects when the claim org is not active (409)', async () => {
    orgStore.seed([
      buildAggregatorOrg({ id: ORG_ID, slug: 'o', status: 'inactive', ownerEmail: 'owner@o.org' }),
    ]);
    const token = await seedInviteAndToken();
    const res = await post({ ...validBody, invite: token });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
  });

  it('a double-submit with the same invite loses the CAS on the second call', async () => {
    const token = await seedInviteAndToken();
    const first = await post({ ...validBody, invite: token });
    expect(first.statusCode).toBe(201);
    const second = await post({ ...validBody, invite: token });
    // Second attempt: invite already consumed → INVITE_ALREADY_USED (not a
    // double-create). (The email is also now registered, but the invite guard
    // fires first.)
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe('INVITE_ALREADY_USED');
  });
});
