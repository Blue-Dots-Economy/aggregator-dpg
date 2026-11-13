import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  _setOrganisationStore,
} from '../../organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../../idp-admin/index.js';
import { approveOrg, grantOwnerAccess } from '../org.js';

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const INVITER = 'invite:00000000-0000-4000-8000-0000000000a1';

describe('approveOrg', () => {
  let store: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let ownerSub: string;
  let groupId: string;

  beforeEach(async () => {
    store = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    const u = await idp.createUser({ email: 'owner@org.test', enabled: false });
    if (!u.ok) throw new Error('seed kc user');
    ownerSub = u.value.id;
    const g = await idp.createGroup('org:example');
    if (!g.ok) throw new Error('seed group');
    groupId = g.value.id;
    _setOrganisationStore(store);
    _setIdpAdmin(idp);
  });

  afterEach(() => {
    _setOrganisationStore(null);
    _setIdpAdmin(null);
  });

  const seedPending = (over = {}) =>
    store.seed([
      buildOrganisation({
        id: ORG_ID,
        slug: 'example',
        status: 'pending',
        ownerEmail: 'owner@org.test',
        ownerKcSub: ownerSub,
        kcGroupId: groupId,
        ...over,
      }),
    ]);

  const approve = () => approveOrg({ orgId: ORG_ID, decidedBy: INVITER, log });

  it('approves: grants owner access and reports granted', async () => {
    seedPending();
    const out = await approve();
    expect(out).toMatchObject({ kind: 'approved', ownerAccess: { status: 'granted' } });
    const kc = await idp.findById(ownerSub);
    expect(kc.ok && kc.value?.enabled).toBe(true);
  });

  it('returns not_found for an unknown org', async () => {
    expect(await approve()).toEqual({ kind: 'not_found' });
  });

  it('returns not_found for the Default org (never decidable)', async () => {
    store.seed([buildDefaultOrg({ id: ORG_ID })]);
    expect(await approve()).toEqual({ kind: 'not_found' });
  });

  it('returns already_decided when the org is no longer pending', async () => {
    seedPending({ status: 'active' });
    expect(await approve()).toEqual({ kind: 'already_decided', status: 'active' });
  });

  it('reports unavailable when the initial read fails', async () => {
    store.findById = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('reports unavailable when the compare-and-set itself errors', async () => {
    seedPending();
    store.approve = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('answers already_decided when the approve CAS loses', async () => {
    seedPending();
    store.approve = async () => {
      await store.update(ORG_ID, { status: 'inactive' });
      return { ok: true, value: null };
    };
    expect(await approve()).toEqual({ kind: 'already_decided', status: 'inactive' });
  });

  it('reports unavailable when the re-read after a lost CAS fails', async () => {
    seedPending();
    let reads = 0;
    const realFind = store.findById.bind(store);
    store.findById = async (id: string) => {
      reads += 1;
      return reads === 1
        ? realFind(id)
        : { ok: false, error: { code: 'DB_UNAVAILABLE' as const, message: 'x' } };
    };
    store.approve = async () => ({ ok: true, value: null });
    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('returns not_found when the row is gone after a lost CAS', async () => {
    seedPending();
    let reads = 0;
    const realFind = store.findById.bind(store);
    store.findById = async (id: string) => {
      reads += 1;
      return reads === 1 ? realFind(id) : { ok: true, value: null };
    };
    store.approve = async () => ({ ok: true, value: null });
    expect(await approve()).toEqual({ kind: 'not_found' });
  });
});

describe('grantOwnerAccess', () => {
  let idp: IdpAdminFake;
  let ownerSub: string;
  let groupId: string;

  beforeEach(async () => {
    idp = new IdpAdminFake();
    const u = await idp.createUser({ email: 'o@test', enabled: false });
    if (!u.ok) throw new Error('seed');
    ownerSub = u.value.id;
    const g = await idp.createGroup('g');
    if (!g.ok) throw new Error('seed');
    groupId = g.value.id;
    _setIdpAdmin(idp);
  });

  afterEach(() => _setIdpAdmin(null));

  it('skips entirely when the owner has no recorded login', async () => {
    const org = buildOrganisation({ ownerKcSub: null });
    expect(await grantOwnerAccess(org, log)).toEqual({
      status: 'no_login',
      enable: 'skipped',
      role: 'skipped',
      group: 'skipped',
    });
  });

  it('grants with the group skipped when the org has no group', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: null });
    const r = await grantOwnerAccess(org, log);
    expect(r).toEqual({ status: 'granted', enable: 'ok', role: 'ok', group: 'skipped' });
  });

  it('fully grants enable, role and group when all succeed', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: groupId });
    const r = await grantOwnerAccess(org, log);
    expect(r).toEqual({ status: 'granted', enable: 'ok', role: 'ok', group: 'ok' });
  });

  it('reports partial when the role assignment fails', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: groupId });
    idp.assignRealmRole = async () => ({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'nope' },
    });
    const r = await grantOwnerAccess(org, log);
    expect(r).toMatchObject({ status: 'partial', enable: 'ok', role: 'failed', group: 'ok' });
  });

  it('reports partial when the user enable fails', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: groupId });
    idp.enableUser = async () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'nope' } });
    const r = await grantOwnerAccess(org, log);
    expect(r).toMatchObject({ status: 'partial', enable: 'failed', role: 'ok', group: 'ok' });
  });

  it('reports partial when adding the user to the group fails', async () => {
    const org = buildOrganisation({ ownerKcSub: ownerSub, kcGroupId: groupId });
    idp.addUserToGroup = async () => ({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'nope' },
    });
    const r = await grantOwnerAccess(org, log);
    expect(r).toMatchObject({ status: 'partial', enable: 'ok', role: 'ok', group: 'failed' });
  });
});
