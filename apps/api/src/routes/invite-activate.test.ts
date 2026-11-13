import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../services/user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../services/organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';

const ROOT = '00000000-0000-4000-8000-000000000001';
const PARENT = '00000000-0000-4000-8000-0000000000c1';
const CHILD = '00000000-0000-4000-8000-0000000000c2';
const COORD = '00000000-0000-4000-8000-0000000000e1';
const COORD_EMAIL = 'asha@trrain.org';
const OWNER_EMAIL = 'ravi@enable.org';

describe('POST /v1/user/activate', () => {
  let app: FastifyInstance;
  let users: UserStoreFake;
  let orgs: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let subjects: Record<string, string>;

  /** Creates the Keycloak login an invite accept leaves behind and returns its id. */
  async function login(
    email: string,
    opts: { verified: boolean; decision?: string; aggregatorId?: string },
  ): Promise<string> {
    const created = await idp.createUser({
      email,
      enabled: true,
      emailVerified: opts.verified,
      attributes: {
        [KC_ATTR.DECISION_MADE]: opts.decision ?? 'invited',
        ...(opts.aggregatorId ? { [KC_ATTR.AGGREGATOR_ID]: opts.aggregatorId } : {}),
      },
    });
    if (!created.ok) throw new Error('seed');
    return created.value.id;
  }

  const activate = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/user/activate',
      headers: { authorization: `Bearer ${token}` },
    });

  const errorCode = (res: { json: () => unknown }) =>
    (res.json() as { error: { code: string } }).error.code;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    users = new UserStoreFake();
    orgs = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    mailer = new FakeMailer();
    subjects = {};
    _setSignalStackWriter(null);
    _setUserStore(users);
    _setOrganisationStore(orgs);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setAccessTokenVerifier(async (token) => {
      if (token === 'service') {
        return {
          sub: 'svc',
          azp: 'aggregator-bff',
          preferred_username: 'service-account-aggregator-bff',
        };
      }
      const sub = subjects[token];
      if (!sub) throw new Error('invalid token');
      return { sub, azp: 'aggregator-portal', preferred_username: token };
    });
    orgs.seedRoot(
      buildOrganisation({
        id: ROOT,
        slug: 'network',
        displayName: 'The Network',
        status: 'active',
        ownerEmail: 'na@net.org',
        depth: 0,
      }),
    );
    orgs.seed([
      buildOrganisation({
        id: PARENT,
        parentId: ROOT,
        slug: 'parent',
        displayName: 'Parent Org',
        status: 'active',
        ownerUserId: '00000000-0000-4000-8000-0000000000a1',
        ownerEmail: 'owner@parent.org',
      }),
    ]);
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    _setSignalStackWriter(null);
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setAccessTokenVerifier(null);
  });

  describe('an invited coordinator', () => {
    beforeEach(() => {
      users.seed([
        buildCoordinator({
          id: COORD,
          parentOrgId: PARENT,
          isDefaultOrg: false,
          status: 'pending',
          serves: ['seeker'],
          contact: { name: 'Asha', email: COORD_EMAIL, phone: '+919876543210' },
        }),
      ]);
    });

    it('becomes active after an email sign-in, and the inviting owner is mailed', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      const res = await activate('coord');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'active', account: 'coordinator', activated: true });
      const row = await users.findById(COORD);
      expect(row.ok && row.value?.status).toBe('active');
      const kc = await idp.findById(subjects.coord);
      expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['approved']);
      expect(mailer.outbox.map((m) => m.to)).toEqual(['owner@parent.org']);
      expect(mailer.outbox[0]?.subject).toContain('has joined');
    });

    it('answers 200 with activated false when already active', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      await activate('coord');
      const again = await activate('coord');
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ activated: false });
      expect(mailer.outbox).toHaveLength(1);
    });

    it('refuses an unverified email with 403 EMAIL_NOT_VERIFIED and stays pending', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: false, aggregatorId: COORD });
      const res = await activate('coord');
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('EMAIL_NOT_VERIFIED');
      const row = await users.findById(COORD);
      expect(row.ok && row.value?.status).toBe('pending');
    });

    it('still activates when the mail to the inviting owner fails', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'down' });
      const res = await activate('coord');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ activated: true });
    });

    it('answers TARGET_ORG_INACTIVE when the coordinator’s org is no longer active', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      await orgs.update(PARENT, { status: 'inactive' });
      const res = await activate('coord');
      expect(errorCode(res)).toBe('TARGET_ORG_INACTIVE');
      const row = await users.findById(COORD);
      expect(row.ok && row.value?.status).toBe('pending');
    });

    it('answers TARGET_ORG_INACTIVE when the coordinator’s org is gone', async () => {
      users.seed([
        buildCoordinator({
          id: COORD,
          parentOrgId: '00000000-0000-4000-8000-0000000000ff',
          isDefaultOrg: false,
          status: 'pending',
          contact: { name: 'Asha', email: COORD_EMAIL, phone: '+919876543210' },
        }),
      ]);
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      expect(errorCode(await activate('coord'))).toBe('TARGET_ORG_INACTIVE');
    });

    it('answers 409 NO_PROFILE_TYPES and stays pending when the invitee serves no profile type', async () => {
      const seeded = await users.findById(COORD);
      if (!seeded.ok || !seeded.value) throw new Error('seed missing');
      users.seed([{ ...seeded.value, serves: [] }]);
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      const res = await activate('coord');
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('NO_PROFILE_TYPES');
      const row = await users.findById(COORD);
      expect(row.ok && row.value?.status).toBe('pending');
    });

    it('answers 503 IDP_UNAVAILABLE when Keycloak cannot be read', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      idp.findById = async () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'x' } });
      const res = await activate('coord');
      expect(res.statusCode).toBe(503);
      expect(errorCode(res)).toBe('IDP_UNAVAILABLE');
    });

    it('answers 503 DB_UNAVAILABLE when the coordinator cannot be read', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      users.findById = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'x' },
      });
      const res = await activate('coord');
      expect(res.statusCode).toBe(503);
      expect(errorCode(res)).toBe('DB_UNAVAILABLE');
    });

    it('stays invited and pending when Signals fails, so the next sign-in activates it', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      class FailingWriter extends SignalStackWriterFake {
        override async upsertAggregator() {
          return err(new UpstreamError('down', { code: 'SIGNALSTACK_UNAVAILABLE' }));
        }
      }
      _setSignalStackWriter(new FailingWriter());
      const res = await activate('coord');
      expect(res.statusCode).toBe(502);
      const row = await users.findById(COORD);
      expect(row.ok && row.value?.status).toBe('pending');
      const kc = await idp.findById(subjects.coord);
      expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);
      expect(kc.ok && kc.value?.enabled).toBe(true);
      expect(mailer.outbox).toHaveLength(0);

      _setSignalStackWriter(null);
      const retry = await activate('coord');
      expect(retry.json()).toMatchObject({ activated: true });
    });

    it('goes back to invited, still enabled, when the pending to active step fails', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      const approve = users.approveFromPending.bind(users);
      users.approveFromPending = async () => {
        users.approveFromPending = approve;
        return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } };
      };
      const res = await activate('coord');
      expect(res.statusCode).toBe(503);
      const kc = await idp.findById(subjects.coord);
      expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);
      expect(kc.ok && kc.value?.enabled).toBe(true);

      const retry = await activate('coord');
      expect(retry.json()).toMatchObject({ activated: true });
      const row = await users.findById(COORD);
      expect(row.ok && row.value?.status).toBe('active');
    });

    it('activates once when two sign-ins activate at the same time', async () => {
      subjects.coord = await login(COORD_EMAIL, { verified: true, aggregatorId: COORD });
      const [a, b] = await Promise.all([activate('coord'), activate('coord')]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const activated = [a, b].map((r) => (r.json() as { activated: boolean }).activated);
      expect(activated.filter(Boolean)).toHaveLength(1);
      expect(mailer.outbox).toHaveLength(1);
      const row = await users.findById(COORD);
      expect(row.ok && row.value?.status).toBe('active');
    });

    it('refuses a self-registered pending coordinator with 403 NOT_INVITED', async () => {
      subjects.coord = await login(COORD_EMAIL, {
        verified: true,
        decision: 'pending',
        aggregatorId: COORD,
      });
      const res = await activate('coord');
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('NOT_INVITED');
    });
  });

  describe('an invited organisation', () => {
    async function seedChild(): Promise<string> {
      const sub = await login(OWNER_EMAIL, { verified: true });
      orgs.seed([
        buildOrganisation({
          id: CHILD,
          parentId: PARENT,
          slug: 'child',
          displayName: 'Child Org',
          status: 'pending',
          ownerEmail: OWNER_EMAIL,
          ownerKcSub: sub,
        }),
      ]);
      return sub;
    }

    it('becomes active with owner access, and the parent owner is mailed', async () => {
      subjects.owner = await seedChild();
      const res = await activate('owner');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'active', account: 'org_owner', activated: true });
      const org = await orgs.findById(CHILD);
      expect(org.ok && org.value?.status).toBe('active');
      const roles = await idp.listRealmRoles(subjects.owner);
      expect(roles.ok && roles.value).toContain('org_owner');
      expect(mailer.outbox.map((m) => m.to)).toEqual(['owner@parent.org']);
    });

    it('still activates when the owner’s decision stamp fails', async () => {
      subjects.owner = await seedChild();
      idp.setUserDecision = async () => ({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'x' },
      });
      const res = await activate('owner');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ account: 'org_owner', activated: true });
    });

    it('reports a failed owner-access grant and completes it on the next sign-in', async () => {
      subjects.owner = await seedChild();
      const assign = idp.assignRealmRole.bind(idp);
      idp.assignRealmRole = async () => {
        idp.assignRealmRole = assign;
        return { ok: false, error: { code: 'BAD_REQUEST', message: 'x' } };
      };
      const res = await activate('owner');
      expect(res.statusCode).toBe(503);
      expect(errorCode(res)).toBe('IDP_UNAVAILABLE');
      expect(mailer.outbox).toHaveLength(0);
      const kc = await idp.findById(subjects.owner);
      expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);

      const retry = await activate('owner');
      expect(retry.statusCode).toBe(200);
      const roles = await idp.listRealmRoles(subjects.owner);
      expect(roles.ok && roles.value).toContain('org_owner');
      const after = await idp.findById(subjects.owner);
      expect(after.ok && after.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['approved']);
    });

    it('answers 503 DB_UNAVAILABLE when the owned org cannot be read', async () => {
      subjects.owner = await seedChild();
      orgs.findByOwnerEmail = async () => ({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'x' },
      });
      const res = await activate('owner');
      expect(res.statusCode).toBe(503);
    });

    it('answers TARGET_ORG_INACTIVE when the parent org is gone', async () => {
      const sub = await login(OWNER_EMAIL, { verified: true });
      orgs.seed([
        buildOrganisation({
          id: CHILD,
          parentId: '00000000-0000-4000-8000-0000000000ff',
          slug: 'child',
          displayName: 'Child Org',
          status: 'pending',
          ownerEmail: OWNER_EMAIL,
          ownerKcSub: sub,
        }),
      ]);
      subjects.owner = sub;
      expect(errorCode(await activate('owner'))).toBe('TARGET_ORG_INACTIVE');
    });

    it('does not activate an org whose owner login is someone else', async () => {
      await seedChild();
      subjects.other = await login('other@x.org', { verified: true });
      const res = await activate('other');
      expect(res.statusCode).toBe(404);
      const org = await orgs.findById(CHILD);
      expect(org.ok && org.value?.status).toBe('pending');
    });
  });

  it('refuses a service-account token with 403', async () => {
    const res = await activate('service');
    expect(res.statusCode).toBe(403);
  });

  it('answers 401 without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/user/activate' });
    expect(res.statusCode).toBe(401);
  });
});
