import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../../user-store/index.js';
import {
  OrganisationStoreFake,
  buildDefaultOrg,
  _setOrganisationStore,
} from '../../organisation-store/index.js';
import { IdpAdminFake, KC_ATTR, _setIdpAdmin } from '../../idp-admin/index.js';
import { _setNetworkConfig } from '../../network-config.js';
import { _setSignalStackWriter } from '../../signalstack.js';
import { approveCoordinator } from '../coordinator.js';

const ID = '11111111-1111-4111-8111-111111111111';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

describe('approveCoordinator', () => {
  let store: UserStoreFake;
  let idp: IdpAdminFake;
  let kcId: string;

  beforeEach(async () => {
    store = new UserStoreFake();
    store.seed([
      buildCoordinator({
        id: ID,
        status: 'pending',
        type: 'seeker',
        parentOrgId: buildDefaultOrg().id,
        isDefaultOrg: true,
      }),
    ]);
    const orgs = new OrganisationStoreFake();
    orgs.seed([buildDefaultOrg()]);
    idp = new IdpAdminFake();
    const user = await idp.createUser({
      email: 'c@x.test',
      enabled: false,
      attributes: { [KC_ATTR.AGGREGATOR_ID]: ID },
    });
    if (!user.ok) throw new Error('seed failed');
    kcId = user.value.id;
    _setUserStore(store);
    _setOrganisationStore(orgs);
    _setIdpAdmin(idp);
    _setNetworkConfig(buildBlueDotConfig());
    _setSignalStackWriter(new SignalStackWriterFake());
  });

  afterEach(() => {
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setNetworkConfig(null);
    _setSignalStackWriter(null);
  });

  const INVITER = 'invite:00000000-0000-4000-8000-0000000000a1';
  const approve = () => approveCoordinator({ aggregatorId: ID, decidedBy: INVITER, log });

  it('approves: enables the user and records who approved', async () => {
    expect(await approve()).toEqual({ kind: 'approved' });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(true);
    const row = await store.findById(ID);
    expect(row.ok && row.value?.updatedBy).toBe(INVITER);
  });

  it.each([
    ['serves nothing', [] as string[]],
    ['serves only ids the network does not have', ['retired']],
  ])('refuses to approve a coordinator that %s, before any write', async (_label, serves) => {
    const row = await store.findById(ID);
    if (!row.ok || !row.value) throw new Error('seed missing');
    store.seed([{ ...row.value, serves }]);
    const signals = new SignalStackWriterFake();
    _setSignalStackWriter(signals);

    expect(await approve()).toEqual({ kind: 'no_profile_types' });
    expect(signals.listAggregators()).toHaveLength(0);
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(false);
    const after = await store.findById(ID);
    expect(after.ok && after.value?.status).toBe('pending');
  });

  it('refuses to approve a coordinator with no types when Signals is not set up', async () => {
    const row = await store.findById(ID);
    if (!row.ok || !row.value) throw new Error('seed missing');
    store.seed([{ ...row.value, serves: [] }]);
    _setSignalStackWriter(null);
    expect(await approve()).toEqual({ kind: 'no_profile_types' });
  });

  it('undoes Keycloak when the row leaves pending before the approval compare-and-set', async () => {
    const real = store.approveFromPending.bind(store);
    store.approveFromPending = async (id, by) => {
      await store.update(id, { status: 'inactive', updatedBy: 'other' });
      return real(id, by);
    };
    expect(await approve()).toEqual({ kind: 'already_decided', status: 'inactive' });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(false);
    expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['rejected']);
  });

  it('leaves the invitee invited and enabled when the approval compare-and-set fails in the database', async () => {
    store.approveFromPending = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'db' });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(true);
    expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);
  });

  it('answers already_decided for a row that is no longer pending', async () => {
    await store.approveFromPending(ID, 'self');
    expect(await approve()).toEqual({ kind: 'already_decided', status: 'active' });
  });

  it('refuses to approve into an inactive org', async () => {
    const orgs = new OrganisationStoreFake();
    orgs.seed([{ ...buildDefaultOrg(), status: 'inactive' }]);
    _setOrganisationStore(orgs);
    expect(await approve()).toEqual({ kind: 'org_inactive' });
  });

  it('reports unavailable db when the org read fails during approve', async () => {
    const orgs = new OrganisationStoreFake();
    orgs.findById = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    _setOrganisationStore(orgs);
    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('maps a coordinator-row read failure to unavailable db', async () => {
    store.findById = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'db' });
  });

  it('maps a missing coordinator row to not_found', async () => {
    store.findById = async () => ({ ok: true, value: null });
    expect(await approve()).toEqual({ kind: 'not_found' });
  });

  it('maps a Keycloak lookup failure to unavailable idp', async () => {
    idp.findByAttribute = async () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'x' } });
    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'idp' });
  });

  it('maps a missing Keycloak user to not_found', async () => {
    idp.findByAttribute = async () => ({ ok: true, value: null });
    expect(await approve()).toEqual({ kind: 'not_found' });
  });

  it('returns not_found when a lost approval finds the row gone', async () => {
    let reads = 0;
    const realFind = store.findById.bind(store);
    store.findById = async (id: string) => {
      reads += 1;
      return reads <= 1 ? realFind(id) : { ok: true, value: null };
    };
    store.approveFromPending = async () => ({ ok: true, value: null });
    expect(await approve()).toEqual({ kind: 'not_found' });
  });

  it('still compensates (logging the failure) when the Keycloak undo itself fails', async () => {
    idp.disableUser = async () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'x' } });
    store.approveFromPending = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'db' });
  });
});
