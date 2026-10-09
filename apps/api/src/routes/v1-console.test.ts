// Console routes /v1/user/* and /v1/org/* (user & org Phase 5): who may do
// what, reach (out of reach → 404), and the decision / edit flows.

import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { join } from 'node:path';
import { loadRbacConfig } from '@aggregator-dpg/rbac';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import { _setRbacRuntime } from '../services/authz/runtime.js';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../services/aggregator-store/index.js';
import {
  AggregatorOrgStoreFake,
  buildAggregatorOrg,
  buildDefaultOrg,
  _setAggregatorOrgStore,
} from '../services/aggregator-org-store/index.js';
import { IdpAdminFake, _setIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { getIdentityStore } from '../services/identity-store/index.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { _setConsoleWriteRateChecker } from '../services/console-rate.js';
import {
  RegistrationInvitesStoreFake,
  _setRegistrationInvitesStore,
} from '../services/registration-invites-store/index.js';
import {
  _setInviteMintRateChecker,
  _setInviteIpRateChecker,
} from '../services/invite-mint-rate.js';

const ROOT = '00000000-0000-4000-8000-000000000001';
const DEFAULT = buildDefaultOrg().id;
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const ORG_P = '00000000-0000-4000-8000-00000000000c';

const NA = '00000000-0000-4000-8000-0000000000a0';
const OWNER_A = '00000000-0000-4000-8000-0000000000aa';
const OWNER_B = '00000000-0000-4000-8000-0000000000ab';
const OWNER_P = '00000000-0000-4000-8000-0000000000ac';

const C1 = '00000000-0000-4000-8000-0000000000c1'; // ORG_A, pending
const C2 = '00000000-0000-4000-8000-0000000000c2'; // ORG_B, pending
const C3 = '00000000-0000-4000-8000-0000000000c3'; // ORG_A, active

/** Token → claims the fake verifier returns. */
const TOKENS: Record<string, Record<string, unknown>> = {
  na: { sub: 'sub-na', preferred_username: 'na@net.org' },
  a: { sub: 'sub-a', preferred_username: 'a@a.org' },
  b: { sub: 'sub-b', preferred_username: 'b@b.org' },
  p: { sub: 'sub-p', preferred_username: 'p@p.org' },
  coord: { sub: 'sub-c3', preferred_username: 'c3@x.org', aggregator_id: C3 },
  unlinked: { sub: 'sub-nobody', preferred_username: 'nobody@x.org' },
  // A login whose aggregator_id claim names a coordinator whose recorded login it is not.
  forged: { sub: 'sub-nobody', preferred_username: 'nobody@x.org', aggregator_id: C3 },
  svc: { sub: 'sub-svc', preferred_username: 'service-account-aggregator-bff' },
};

const auth = (who: keyof typeof TOKENS) => ({ authorization: `Bearer ${who}` });

describe('console routes /v1/user, /v1/org', () => {
  let app: FastifyInstance;
  let coordinators: AggregatorStoreFake;
  let orgs: AggregatorOrgStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;

  function coordinator(id: string, orgId: string, status: 'pending' | 'active', n: number) {
    return buildAggregator({
      id,
      orgSlug: `coord-${n}`,
      name: `Coordinator ${n}`,
      parentOrgId: orgId,
      isDefaultOrg: false,
      status,
      contact: { name: `C${n}`, phone: `+91900000010${n}`, email: `c${n}@x.org` },
      contactPhone: `+91900000010${n}`,
      contactEmail: `c${n}@x.org`,
      createdAt: new Date(`2026-02-0${n}T00:00:00Z`),
    });
  }

  beforeEach(async () => {
    _resetJwks();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';

    coordinators = new AggregatorStoreFake();
    orgs = new AggregatorOrgStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();

    orgs.seedRoot(
      buildAggregatorOrg({
        id: ROOT,
        slug: 'network',
        displayName: 'The Network',
        status: 'active',
        ownerUserId: NA,
        ownerEmail: 'na@net.org',
      }),
    );
    orgs.seed([
      { ...buildDefaultOrg(), ownerUserId: NA, ownerEmail: 'na@net.org' },
      buildAggregatorOrg({
        id: ORG_A,
        slug: 'org-a',
        displayName: 'Alpha',
        status: 'active',
        ownerUserId: OWNER_A,
        ownerEmail: 'a@a.org',
        ownerKcSub: 'sub-a',
      }),
      buildAggregatorOrg({
        id: ORG_B,
        slug: 'org-b',
        displayName: 'Beta',
        status: 'active',
        ownerUserId: OWNER_B,
        ownerEmail: 'b@b.org',
      }),
      buildAggregatorOrg({
        id: ORG_P,
        slug: 'org-p',
        displayName: 'Pending Org',
        status: 'pending',
        ownerUserId: OWNER_P,
        ownerEmail: 'p@p.org',
      }),
    ]);
    coordinators.seed([
      coordinator(C1, ORG_A, 'pending', 1),
      coordinator(C2, ORG_B, 'pending', 2),
      coordinator(C3, ORG_A, 'active', 3),
    ]);
    for (const [id, n] of [
      [C1, 1],
      [C2, 2],
    ] as const) {
      await idp.createUser({
        email: `c${n}@x.org`,
        enabled: false,
        attributes: { [KC_ATTR.AGGREGATOR_ID]: id },
      });
    }

    const identities = getIdentityStore();
    for (const [user, sub] of [
      [NA, 'sub-na'],
      [OWNER_A, 'sub-a'],
      [OWNER_B, 'sub-b'],
      [OWNER_P, 'sub-p'],
      [C1, 'sub-c1'],
      [C3, 'sub-c3'],
    ] as const) {
      await identities.link(user, 'keycloak', sub);
    }

    _setAggregatorStore(coordinators);
    _setAggregatorOrgStore(orgs);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setNetworkConfig(buildBlueDotConfig());
    _setSignalStackWriter(new SignalStackWriterFake());
    _setRegistrationInvitesStore(new RegistrationInvitesStoreFake());
    _setConsoleWriteRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    _setInviteMintRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    _setInviteIpRateChecker(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    _setAccessTokenVerifier(async (token) => {
      const claims = TOKENS[token];
      if (!claims) throw new Error('invalid token');
      return { azp: 'aggregator-portal', ...claims };
    });

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setAggregatorStore(null);
    _setAggregatorOrgStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setNetworkConfig(null);
    _setSignalStackWriter(null);
    _setRegistrationInvitesStore(null);
    _setConsoleWriteRateChecker(null);
    _setInviteMintRateChecker(null);
    _setInviteIpRateChecker(null);
    _setAccessTokenVerifier(null);
  });

  const get = (url: string, who: keyof typeof TOKENS) =>
    app.inject({ method: 'GET', url, headers: auth(who) });
  const post = (url: string, who: keyof typeof TOKENS, payload: object) =>
    app.inject({ method: 'POST', url, headers: auth(who), payload });
  const patch = (url: string, who: keyof typeof TOKENS, payload: object) =>
    app.inject({ method: 'PATCH', url, headers: auth(who), payload });

  describe('the guard', () => {
    it('401 without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/user/read/me' });
      expect(res.statusCode).toBe(401);
    });

    it.each([
      ['svc', 403, 'FORBIDDEN'],
      ['unlinked', 403, 'USER_NOT_PROVISIONED'],
      ['p', 403, 'NOT_ORG_ADMIN'],
      ['forged', 403, 'USER_NOT_PROVISIONED'],
    ] as const)('%s → %i %s', async (who, status, code) => {
      const res = await get('/v1/user/read/me', who);
      expect(res.statusCode).toBe(status);
      expect((res.json() as { error: { code: string } }).error.code).toBe(code);
    });

    it('refuses a pending coordinator with NOT_APPROVED', async () => {
      TOKENS.c1 = { sub: 'sub-c1', aggregator_id: C1 };
      const res = await get('/v1/user/read/me', 'c1' as keyof typeof TOKENS);
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_APPROVED');
      delete TOKENS.c1;
    });

    it('refuses a coordinator on an admin route with 403', async () => {
      const res = await get(`/v1/user/read/${C1}`, 'coord');
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /v1/user/read/me', () => {
    it('describes the network admin: root + Default, flagged', async () => {
      const res = await get('/v1/user/read/me', 'na');
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        kind: string;
        is_network_admin: boolean;
        orgs: Array<{ id: string; org_type: string; role: string }>;
        user: { contact: { email: string } };
      };
      expect(body.kind).toBe('admin');
      expect(body.is_network_admin).toBe(true);
      expect(body.orgs.map((o) => o.id).sort()).toEqual([ROOT, DEFAULT].sort());
      expect(body.user.contact.email).toBe('na@net.org');
    });

    it('describes an owner: its org only, not the network admin', async () => {
      const body = (await get('/v1/user/read/me', 'a')).json() as {
        is_network_admin: boolean;
        orgs: Array<{ id: string; role: string }>;
      };
      expect(body.is_network_admin).toBe(false);
      expect(body.orgs).toEqual([expect.objectContaining({ id: ORG_A, role: 'owner' })]);
    });

    it('describes an approved coordinator as a member of its org', async () => {
      const body = (await get('/v1/user/read/me', 'coord')).json() as {
        kind: string;
        orgs: Array<{ id: string; role: string }>;
        user: { contact: { email: string } };
      };
      expect(body.kind).toBe('coordinator');
      expect(body.orgs).toEqual([expect.objectContaining({ id: ORG_A, role: 'member' })]);
      expect(body.user.contact.email).toBe('c3@x.org');
    });
  });

  describe('reach', () => {
    it.each([
      ['a', C1, 200],
      ['a', C2, 404],
      ['na', C2, 200],
      ['b', C1, 404],
    ] as const)('%s reads coordinator %s → %i', async (who, id, status) => {
      expect((await get(`/v1/user/read/${id}`, who)).statusCode).toBe(status);
    });

    it.each([
      ['a', ORG_A, 200],
      ['a', ORG_B, 404],
      ['a', ROOT, 404],
      ['na', ROOT, 200],
      ['na', ORG_B, 200],
    ] as const)('%s reads org %s → %i', async (who, id, status) => {
      expect((await get(`/v1/org/read/${id}`, who)).statusCode).toBe(status);
    });

    it('reads the root as the network facilitator, with owner and counts', async () => {
      const body = (await get(`/v1/org/read/${ORG_A}`, 'a')).json() as {
        org: { org_type: string };
        coordinator_count: number;
        pending_count: number;
        owner: { id: string };
      };
      expect(body.org.org_type).toBe('aggregator');
      expect(body.coordinator_count).toBe(2);
      expect(body.pending_count).toBe(1);
      expect(body.owner.id).toBe(OWNER_A);
      const root = (await get(`/v1/org/read/${ROOT}`, 'na')).json() as {
        org: { org_type: string };
      };
      expect(root.org.org_type).toBe('network_facilitator');
    });
  });

  describe('POST /v1/user/search', () => {
    const ids = (res: { json: () => unknown }) =>
      (res.json() as { users: Array<{ id: string }> }).users.map((u) => u.id).sort();

    it('scopes an owner to its org, the network admin to all', async () => {
      expect(ids(await post('/v1/user/search', 'a', {}))).toEqual([C1, C3].sort());
      expect(ids(await post('/v1/user/search', 'na', {}))).toEqual([C1, C2, C3].sort());
    });

    it('answers an out-of-reach org_id with an empty page', async () => {
      const res = await post('/v1/user/search', 'a', { filter: { org_id: ORG_B } });
      expect(res.statusCode).toBe(200);
      expect(ids(res)).toEqual([]);
    });

    it('pages with an opaque cursor', async () => {
      const first = (await post('/v1/user/search', 'na', { limit: 2 })).json() as {
        users: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(first.users.map((u) => u.id)).toEqual([C3, C2]);
      expect(first.next_cursor).not.toBeNull();
      const second = (
        await post('/v1/user/search', 'na', { limit: 2, cursor: first.next_cursor })
      ).json() as { users: Array<{ id: string }>; next_cursor: string | null };
      expect(second.users.map((u) => u.id)).toEqual([C1]);
      expect(second.next_cursor).toBeNull();
    });

    it('refuses a malformed cursor with 400', async () => {
      const res = await post('/v1/user/search', 'na', { cursor: 'not-a-cursor' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/user/decision/:id', () => {
    it('lets the owner approve its coordinator, then answers ALREADY_DECIDED', async () => {
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: C1, status: 'active' });
      const row = await coordinators.findById(C1);
      expect(row.ok && row.value?.status).toBe('active');
      expect(row.ok && row.value?.updatedBy).toBe(OWNER_A);

      const again = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'reject' });
      expect(again.statusCode).toBe(409);
      const err = (again.json() as { error: { code: string; fields: Record<string, unknown> } })
        .error;
      expect(err.code).toBe('ALREADY_DECIDED');
      expect(err.fields).toMatchObject({ status: 'active', decided_by: 'console' });
    });

    it("answers 404 for another org's coordinator", async () => {
      const res = await post(`/v1/user/decision/${C2}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(404);
      const row = await coordinators.findById(C2);
      expect(row.ok && row.value?.status).toBe('pending');
    });

    it('tells the owner when the network admin decides in their org (C13)', async () => {
      const res = await post(`/v1/user/decision/${C2}`, 'na', {
        decision: 'reject',
        reason: 'incomplete',
      });
      expect(res.statusCode).toBe(200);
      const notice = mailer.outbox.find((m) => m.to === 'b@b.org');
      expect(notice?.html).toContain('rejected a coordinator');
    });

    it('answers 429 when the console write budget is spent', async () => {
      _setConsoleWriteRateChecker(async () => ({ allowed: false, retryAfterSeconds: 30 }));
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('30');
    });
  });

  describe('PATCH /v1/user/metadata/update/:id', () => {
    it('sets the served domains', async () => {
      const res = await patch(`/v1/user/metadata/update/${C3}`, 'a', { serves: ['seeker'] });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { serves: string[] }).serves).toEqual(['seeker']);
    });

    it('refuses a domain the network does not have', async () => {
      const res = await patch(`/v1/user/metadata/update/${C3}`, 'a', { serves: ['pilot'] });
      expect(res.statusCode).toBe(400);
    });

    it('answers 404 out of reach', async () => {
      const res = await patch(`/v1/user/metadata/update/${C2}`, 'a', { serves: [] });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /v1/user/create (invite)', () => {
    it('invites into the owner’s org', async () => {
      const res = await post('/v1/user/create', 'a', {
        org_id: ORG_A,
        recipients: [{ email: 'new@x.org' }],
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { sent: number }).sent).toBe(1);
    });

    it('answers 404 for an org out of reach', async () => {
      const res = await post('/v1/user/create', 'a', {
        org_id: ORG_B,
        recipients: [{ email: 'new@x.org' }],
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses the Default org, even for the network admin (R8)', async () => {
      const res = await post('/v1/user/create', 'na', {
        org_id: DEFAULT,
        recipients: [{ email: 'new@x.org' }],
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /v1/org/search', () => {
    const ids = (res: { json: () => unknown }) =>
      (res.json() as { orgs: Array<{ id: string }> }).orgs.map((o) => o.id).sort();

    it('scopes an owner to its org; the network admin sees every aggregator org', async () => {
      expect(ids(await post('/v1/org/search', 'a', {}))).toEqual([ORG_A]);
      expect(ids(await post('/v1/org/search', 'na', {}))).toEqual(
        [DEFAULT, ORG_A, ORG_B, ORG_P].sort(),
      );
    });

    it('filters by status', async () => {
      expect(ids(await post('/v1/org/search', 'na', { filter: { status: 'pending' } }))).toEqual([
        ORG_P,
      ]);
    });
  });

  describe('PATCH /v1/org/metadata/update/:id', () => {
    it('lets the owner edit details', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {
        url: 'https://alpha.example.org',
        legal_name: 'Alpha Pvt Ltd',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        url: 'https://alpha.example.org',
        legal_name: 'Alpha Pvt Ltd',
      });
    });

    it('refuses the name to an owner (403)', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', { name: 'Alpha 2' });
      expect(res.statusCode).toBe(403);
    });

    it('lets the network admin rename, and tells the owner (C13)', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'na', { name: 'Alpha Two' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { name: string }).name).toBe('Alpha Two');
      const notice = mailer.outbox.find((m) => m.to === 'a@a.org');
      expect(notice?.html).toContain('updated the name');
      expect(notice?.html).not.toContain('Alpha Two</strong> as');
    });

    it('answers ORG_NAME_TAKEN for a duplicate name', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'na', { name: 'beta' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('ORG_NAME_TAKEN');
    });

    it('never edits the Default org', async () => {
      const res = await patch(`/v1/org/metadata/update/${DEFAULT}`, 'na', {
        url: 'https://x.example.org',
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses an empty body', async () => {
      const res = await patch(`/v1/org/metadata/update/${ORG_A}`, 'a', {});
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/org/decision/:id and access repair', () => {
    it('is the network admin’s only', async () => {
      expect(
        (await post(`/v1/org/decision/${ORG_P}`, 'a', { decision: 'approve' })).statusCode,
      ).toBe(403);
      expect((await post(`/v1/org/access/repair/${ORG_A}`, 'a', {})).statusCode).toBe(403);
    });

    it('approves a pending org, then answers ALREADY_DECIDED', async () => {
      const res = await post(`/v1/org/decision/${ORG_P}`, 'na', { decision: 'approve' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_P, status: 'active', owner_access: 'no_login' });
      const again = await post(`/v1/org/decision/${ORG_P}`, 'na', { decision: 'reject' });
      expect(again.statusCode).toBe(409);
      expect(
        (again.json() as { error: { fields: { decided_by: string } } }).error.fields.decided_by,
      ).toBe('console');
    });

    it("repairs an active org's owner access", async () => {
      await idp.createUser({ email: 'a@a.org', enabled: false, attributes: {} });
      const res = await post(`/v1/org/access/repair/${ORG_A}`, 'na', {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ORG_A });
    });
  });
  // RBAC on top of Phase 5's checks: the capability each console route
  // declares (route-access snapshot), decided per request.
  describe('with RBAC enforced', () => {
    beforeEach(async () => {
      const { config } = await loadRbacConfig([join(process.env.CONFIG_ROOT ?? '', 'rbac.yaml')]);
      _setRbacRuntime({ mode: 'enforce', config, authorizer: new AuthorizerFake() });
    });
    afterEach(() => _setRbacRuntime(null));

    const permissionOf = (res: { json(): unknown }) =>
      (res.json() as { error: { fields?: { permission?: string } } }).error.fields?.permission;

    it('lets an aggregator owner approve its coordinator (org.manage)', async () => {
      const res = await post(`/v1/user/decision/${C1}`, 'a', { decision: 'approve' });
      expect(res.statusCode).toBe(200);
    });

    it('refuses an aggregator owner the network admin capabilities', async () => {
      const repair = await post(`/v1/org/access/repair/${ORG_A}`, 'a', {});
      expect(repair.statusCode).toBe(403);
      expect(permissionOf(repair)).toBe('network.administer');
      const decide = await post(`/v1/org/decision/${ORG_P}`, 'a', { decision: 'approve' });
      expect(decide.statusCode).toBe(403);
      expect(permissionOf(decide)).toBe('orgs.onboard');
    });

    it('lets the network admin repair access', async () => {
      await idp.createUser({ email: 'a@a.org', enabled: false, attributes: {} });
      expect((await post(`/v1/org/access/repair/${ORG_A}`, 'na', {})).statusCode).toBe(200);
    });

    it('lets a signed-in coordinator read itself', async () => {
      expect((await get('/v1/user/read/me', 'coord')).statusCode).toBe(200);
    });

    it('lists the caller capabilities on read/me', async () => {
      const me = (await get('/v1/user/read/me', 'a')).json() as { capabilities: string[] };
      expect(me.capabilities).toContain('org.manage');
      expect(me.capabilities).toContain('contact.unmask');
      expect(me.capabilities).not.toContain('network.administer');
      expect(me.capabilities).not.toContain('profiles.view_pii');
      const na = (await get('/v1/user/read/me', 'na')).json() as { capabilities: string[] };
      expect(na.capabilities).toContain('network.administer');
    });

    it('returns null capabilities when RBAC is off', async () => {
      _setRbacRuntime(null);
      const me = (await get('/v1/user/read/me', 'a')).json() as { capabilities: unknown };
      expect(me.capabilities).toBeNull();
    });

    it('masks contacts for a role without contact.unmask', async () => {
      const { config } = await loadRbacConfig([join(process.env.CONFIG_ROOT ?? '', 'rbac.yaml')]);
      const noUnmask = {
        ...config,
        roles: {
          ...config.roles,
          admin: (config.roles.admin ?? []).filter((c) => c !== 'contact.unmask'),
        },
      };
      _setRbacRuntime({ mode: 'enforce', config: noUnmask, authorizer: new AuthorizerFake() });
      const one = (await get(`/v1/user/read/${C1}`, 'a')).json() as {
        contact: { email: string; phone: string | null };
      };
      expect(one.contact.email).toMatch(/^.\*\*\*@/);
      const list = (await post('/v1/user/search', 'a', { filter: {} })).json() as {
        users: Array<{ contact: { email: string } }>;
      };
      expect(list.users.length).toBeGreaterThan(0);
      for (const u of list.users) expect(u.contact.email).toMatch(/^.\*\*\*@/);
    });

    it('shows contacts plain to a role with contact.unmask', async () => {
      const one = (await get(`/v1/user/read/${C1}`, 'a')).json() as { contact: { email: string } };
      expect(one.contact.email).toBe('c1@x.org');
    });
  });
});
