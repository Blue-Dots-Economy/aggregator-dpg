import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore } from '../services/user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import {
  RegistrationInvitesStoreFake,
  buildRegistrationInvite,
  _setRegistrationInvitesStore,
  type InviteRole,
} from '../services/registration-invites-store/index.js';
import { IdpAdminFake, _setIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _resetTokenKey } from '../services/approval-token.js';
import { mintInviteToken, _resetInviteTokenKey } from '../services/invite-token.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSubmitRateChecker } from '../services/submit-rate.js';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { _setConsentLedger } from '../services/consent-ledger/index.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { _setNetworkConfig } from '../services/network-config.js';

const AUTH_HEADER = { authorization: 'Bearer service-token' };
const ROOT = '00000000-0000-4000-8000-000000000001';
const PARENT = '00000000-0000-4000-8000-0000000000c1';
const COORD_EMAIL = 'asha@trrain.org';
const OWNER_EMAIL = 'ravi@enable.org';

describe('invite read and accept routes', () => {
  let app: FastifyInstance;
  let userStore: UserStoreFake;
  let orgStore: OrganisationStoreFake;
  let invites: RegistrationInvitesStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  const coordinatorBody = {
    name: 'TRRAIN',
    type: 'seeker',
    contact: { name: 'Asha Kumari', phone: '+919876543210', email: COORD_EMAIL },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2099-01-15T10:00:00Z' },
  };
  const orgBody = {
    display_name: 'Enable India',
    state: 'Karnataka',
    owner: { name: 'Ravi Kumar', email: OWNER_EMAIL, phone: '+919876500000' },
    consent: { value: true, given_at: '2026-01-15T10:00:00Z', valid_till: '2099-01-15T10:00:00Z' },
  };

  /** Seeds a pending invite and returns a token for it. */
  async function inviteToken(
    role: InviteRole,
    overrides: Parameters<typeof buildRegistrationInvite>[0] = {},
  ): Promise<string> {
    const invite = buildRegistrationInvite({
      jti: `inv-${role}`,
      role,
      parentOrgId: PARENT,
      email: role === 'org_owner' ? OWNER_EMAIL : COORD_EMAIL,
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    });
    invites.seed([invite]);
    const { token } = await mintInviteToken({
      jti: invite.jti,
      role,
      org: invite.parentOrgId,
      email: invite.email,
    });
    return token;
  }

  async function inviteStatus(jti: string): Promise<string | undefined> {
    const row = await invites.findByJti(jti);
    return row.ok ? row.value?.status : undefined;
  }

  function useMaxDepth(maxDepth: number): void {
    const base = buildBlueDotConfig();
    _setNetworkConfig(
      buildBlueDotConfig({
        aggregator: {
          ...base.aggregator,
          organisation: { hierarchy: { max_depth: maxDepth, max_total_orgs: 50 } },
        },
      }),
    );
  }

  const errorCode = (res: { json: () => unknown }) =>
    (res.json() as { error: { code: string } }).error.code;

  beforeEach(async () => {
    _resetTokenKey();
    _resetInviteTokenKey();
    _resetJwks();
    _setSubmitRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.ADMIN_EMAILS = 'reviewer@bluedots.local';
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    userStore = new UserStoreFake();
    orgStore = new OrganisationStoreFake();
    invites = new RegistrationInvitesStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();
    _setUserStore(userStore);
    _setOrganisationStore(orgStore);
    _setRegistrationInvitesStore(invites);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setConsentLedger(new ConsentLedgerFake());
    useMaxDepth(3);
    _setAccessTokenVerifier(async (token) => {
      if (token === 'service-token') {
        return { sub: 'service-account-aggregator-bff', azp: 'aggregator-bff' };
      }
      throw new Error('invalid token');
    });
    orgStore.seedRoot(
      buildOrganisation({
        id: ROOT,
        slug: 'network',
        displayName: 'The Network',
        status: 'active',
        depth: 0,
      }),
    );
    orgStore.seed([
      buildOrganisation({
        id: PARENT,
        parentId: ROOT,
        slug: 'parent',
        displayName: 'Parent Org',
        status: 'active',
        ownerEmail: 'owner@parent.org',
        depth: 1,
      }),
    ]);
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setRegistrationInvitesStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setAccessTokenVerifier(null);
    _setSubmitRateChecker(null);
    _setConsentLedger(null);
    _setNetworkConfig(null);
  });

  const read = (path: string, token: string) =>
    app.inject({
      method: 'GET',
      url: `${path}?token=${encodeURIComponent(token)}`,
      headers: AUTH_HEADER,
    });
  const accept = (path: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: path, headers: AUTH_HEADER, payload });

  describe('GET /v1/user/invite/read', () => {
    it('returns the invited email and the org, and leaves the invite pending', async () => {
      const res = await read('/v1/user/invite/read', await inviteToken('coordinator'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        email: COORD_EMAIL,
        org: { id: PARENT, name: 'Parent Org' },
      });
      expect(await inviteStatus('inv-coordinator')).toBe('pending');
    });

    it('refuses an org invite with 400 INVITE_INVALID', async () => {
      const res = await read('/v1/user/invite/read', await inviteToken('org_owner'));
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('INVITE_INVALID');
    });

    it('answers 409 INVITE_ALREADY_USED for a used invite', async () => {
      const token = await inviteToken('coordinator', { status: 'consumed' });
      const res = await read('/v1/user/invite/read', token);
      expect(res.statusCode).toBe(409);
    });

    it('answers 410 INVITE_EXPIRED for an expired invite row', async () => {
      const token = await inviteToken('coordinator', { status: 'expired' });
      const res = await read('/v1/user/invite/read', token);
      expect(res.statusCode).toBe(410);
    });

    it('answers 400 for a token that is not a JWT', async () => {
      const res = await read('/v1/user/invite/read', 'not-a-token');
      expect(res.statusCode).toBe(400);
    });

    it('answers 409 TARGET_ORG_INACTIVE when the org is no longer active', async () => {
      const token = await inviteToken('coordinator');
      const found = await orgStore.findById(PARENT);
      if (!found.ok || !found.value) throw new Error('seed');
      orgStore.seed([{ ...found.value, status: 'inactive' }]);
      const res = await read('/v1/user/invite/read', token);
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('TARGET_ORG_INACTIVE');
    });
  });

  describe('GET /v1/org/invite/read', () => {
    it('returns the invited owner email and the inviting org', async () => {
      const res = await read('/v1/org/invite/read', await inviteToken('org_owner'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ email: OWNER_EMAIL, org: { id: PARENT } });
    });

    it('accepts an invite from the network root', async () => {
      const token = await inviteToken('org_owner', { parentOrgId: ROOT });
      const res = await read('/v1/org/invite/read', token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ org: { id: ROOT, name: 'The Network' } });
    });

    it('refuses a coordinator invite with 400 INVITE_INVALID', async () => {
      const res = await read('/v1/org/invite/read', await inviteToken('coordinator'));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/user/invite/accept', () => {
    it('creates a pending coordinator whose login is enabled, unverified and marked invited', async () => {
      const token = await inviteToken('coordinator');
      const res = await accept('/v1/user/invite/accept', { ...coordinatorBody, invite: token });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { aggregator_id: string; status: string; login_hint: string };
      expect(body).toMatchObject({ status: 'pending', login_hint: COORD_EMAIL });
      const stored = await userStore.findById(body.aggregator_id);
      expect(stored.ok && stored.value?.status).toBe('pending');
      expect(stored.ok && stored.value?.parentOrgId).toBe(PARENT);
      const kc = await idp.findByEmail(COORD_EMAIL);
      expect(kc.ok && kc.value).toMatchObject({
        enabled: true,
        emailVerified: false,
        attributes: expect.objectContaining({ [KC_ATTR.DECISION_MADE]: ['invited'] }),
      });
      expect(await inviteStatus('inv-coordinator')).toBe('consumed');
      expect(mailer.outbox).toHaveLength(0);
    });

    it('refuses another email with 400 INVITE_EMAIL_MISMATCH and keeps the invite', async () => {
      const token = await inviteToken('coordinator');
      const res = await accept('/v1/user/invite/accept', {
        ...coordinatorBody,
        contact: { ...coordinatorBody.contact, email: 'other@trrain.org' },
        invite: token,
      });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('INVITE_EMAIL_MISMATCH');
      expect(await inviteStatus('inv-coordinator')).toBe('pending');
    });

    it('refuses a body without an invite with 400', async () => {
      const res = await accept('/v1/user/invite/accept', coordinatorBody);
      expect(res.statusCode).toBe(400);
    });

    it('refuses an org invite with 400 INVITE_INVALID', async () => {
      const token = await inviteToken('org_owner', { email: COORD_EMAIL });
      const res = await accept('/v1/user/invite/accept', { ...coordinatorBody, invite: token });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('INVITE_INVALID');
    });

    it('registers once per link: a second accept answers 409', async () => {
      const token = await inviteToken('coordinator');
      expect(
        (await accept('/v1/user/invite/accept', { ...coordinatorBody, invite: token })).statusCode,
      ).toBe(201);
      const again = await accept('/v1/user/invite/accept', { ...coordinatorBody, invite: token });
      expect(again.statusCode).toBe(409);
    });

    it('registers once when the same link is accepted several times at once', async () => {
      const token = await inviteToken('coordinator');
      const rs = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          accept('/v1/user/invite/accept', {
            ...coordinatorBody,
            contact: { ...coordinatorBody.contact, phone: `+91987654321${n}` },
            invite: token,
          }),
        ),
      );
      expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
      for (const r of rs.filter((x) => x.statusCode !== 201)) {
        expect(r.statusCode).toBe(409);
        expect(errorCode(r)).toBe('INVITE_ALREADY_USED');
      }
      const stored = await userStore.findByContactEmail(COORD_EMAIL);
      expect(stored.ok && stored.value?.status).toBe('pending');
      expect(await inviteStatus('inv-coordinator')).toBe('consumed');
    });

    it('refuses an org owner as a coordinator with 409 OWNER_ALREADY_REGISTERED', async () => {
      orgStore.seed([
        buildOrganisation({
          id: '00000000-0000-4000-8000-0000000000d2',
          parentId: ROOT,
          slug: 'owned',
          status: 'active',
          ownerEmail: COORD_EMAIL,
        }),
      ]);
      const token = await inviteToken('coordinator');
      const res = await accept('/v1/user/invite/accept', { ...coordinatorBody, invite: token });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('OWNER_ALREADY_REGISTERED');
      expect(await inviteStatus('inv-coordinator')).toBe('pending');
    });

    it("refuses the org's url and locations with 409 ORG_DETAILS_READ_ONLY", async () => {
      const token = await inviteToken('coordinator');
      const res = await accept('/v1/user/invite/accept', {
        ...coordinatorBody,
        url: 'https://trrain.org',
        invite: token,
      });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('ORG_DETAILS_READ_ONLY');
    });

    it.each([
      ['expired', { status: 'expired' as const }, 410],
      ['already used', { status: 'consumed' as const }, 409],
      ['revoked', { status: 'revoked' as const }, 400],
    ])('refuses an %s invite', async (_label, overrides, status) => {
      const token = await inviteToken('coordinator', overrides);
      const res = await accept('/v1/user/invite/accept', { ...coordinatorBody, invite: token });
      expect(res.statusCode).toBe(status);
    });

    it('refuses a tampered token with 400 INVITE_INVALID', async () => {
      const token = await inviteToken('coordinator');
      const res = await accept('/v1/user/invite/accept', {
        ...coordinatorBody,
        invite: `${token.slice(0, -2)}xx`,
      });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('INVITE_INVALID');
    });

    it('gives the invite back when Keycloak is down', async () => {
      const token = await inviteToken('coordinator');
      idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
      const res = await accept('/v1/user/invite/accept', { ...coordinatorBody, invite: token });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(await inviteStatus('inv-coordinator')).toBe('pending');
    });
  });

  describe('POST /v1/org/invite/accept', () => {
    it('creates a pending org under the inviting org with an enabled, unverified, invited owner', async () => {
      const token = await inviteToken('org_owner');
      const res = await accept('/v1/org/invite/accept', { ...orgBody, invite: token });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { org_id: string; status: string; login_hint: string };
      expect(body).toMatchObject({ status: 'pending', login_hint: OWNER_EMAIL });
      const org = await orgStore.findById(body.org_id);
      expect(org.ok && org.value).toMatchObject({ status: 'pending', parentId: PARENT });
      const kc = await idp.findByEmail(OWNER_EMAIL);
      expect(kc.ok && kc.value).toMatchObject({
        enabled: true,
        emailVerified: false,
        attributes: expect.objectContaining({ [KC_ATTR.DECISION_MADE]: ['invited'] }),
      });
      expect(await inviteStatus('inv-org_owner')).toBe('consumed');
      expect(mailer.outbox).toHaveLength(0);
    });

    it('places an org invited by the network admin directly under the root', async () => {
      const token = await inviteToken('org_owner', { parentOrgId: ROOT });
      const res = await accept('/v1/org/invite/accept', { ...orgBody, invite: token });
      expect(res.statusCode).toBe(201);
      const org = await orgStore.findById((res.json() as { org_id: string }).org_id);
      expect(org.ok && org.value?.parentId).toBe(ROOT);
    });

    it('ignores a parent_id in the body and uses the inviting org', async () => {
      const token = await inviteToken('org_owner');
      const res = await accept('/v1/org/invite/accept', {
        ...orgBody,
        parent_id: ROOT,
        invite: token,
      });
      expect(res.statusCode).toBe(201);
      const org = await orgStore.findById((res.json() as { org_id: string }).org_id);
      expect(org.ok && org.value?.parentId).toBe(PARENT);
    });

    it('refuses another owner email with 400 INVITE_EMAIL_MISMATCH and keeps the invite', async () => {
      const token = await inviteToken('org_owner');
      const res = await accept('/v1/org/invite/accept', {
        ...orgBody,
        owner: { ...orgBody.owner, email: 'someone@else.org' },
        invite: token,
      });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('INVITE_EMAIL_MISMATCH');
      expect(await inviteStatus('inv-org_owner')).toBe('pending');
    });

    it('refuses an owner who already has an org with 409 and keeps the invite', async () => {
      orgStore.seed([
        buildOrganisation({
          id: '00000000-0000-4000-8000-0000000000d1',
          parentId: ROOT,
          slug: 'mine',
          displayName: 'Already Mine',
          status: 'active',
          ownerEmail: OWNER_EMAIL,
        }),
      ]);
      const token = await inviteToken('org_owner');
      const res = await accept('/v1/org/invite/accept', { ...orgBody, invite: token });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('OWNER_ALREADY_REGISTERED');
      expect(await inviteStatus('inv-org_owner')).toBe('pending');
    });

    it('gives the invite back when the inviting org can no longer take a child', async () => {
      useMaxDepth(1);
      const token = await inviteToken('org_owner');
      const res = await accept('/v1/org/invite/accept', { ...orgBody, invite: token });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('ORG_DEPTH_LIMIT');
      expect(await inviteStatus('inv-org_owner')).toBe('pending');
    });
  });
});
