import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../../user-store/index.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../../organisation-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../../idp-admin/index.js';
import { IDP_PROVIDER } from '../../idp-admin/provider.js';
import { IdentityStoreFake } from '../../identity-store/testing.js';
import { _setIdentityStore } from '../../identity-store/index.js';
import { _setNetworkConfig } from '../../network-config.js';
import { _setSignalStackWriter } from '../../signalstack.js';
import { approveCoordinator } from '../coordinator.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

/** Every Keycloak user write a coordinator path could make. */
const USER_WRITES = [
  'enableUser',
  'disableUser',
  'setUserDecision',
  'setAttributes',
  'logoutSessions',
] as const;

describe('approveCoordinator on a shared login', () => {
  let store: UserStoreFake;
  let idp: IdpAdminFake;
  let signals: SignalStackWriterFake;
  /** The owner's Keycloak user, shared by both accounts. */
  let SUB: string;

  beforeEach(async () => {
    idp = new IdpAdminFake();
    const owner = await idp.createUser({ email: 'owner@example.org' });
    if (!owner.ok) throw new Error('fake createUser failed');
    SUB = owner.value.id;
    store = new UserStoreFake();
    store.seed([
      buildCoordinator({
        id: ID,
        status: 'pending',
        serves: ['seeker'],
        type: 'seeker',
        parentOrgId: ORG,
        isDefaultOrg: false,
      }),
    ]);
    const orgs = new OrganisationStoreFake();
    orgs.seed([buildOrganisation({ id: ORG, status: 'active', ownerUserId: ADMIN })]);
    const identities = new IdentityStoreFake();
    identities.seed([
      { userId: ADMIN, userType: 'admin', provider: IDP_PROVIDER, subject: SUB },
      { userId: ID, userType: 'coordinator', provider: IDP_PROVIDER, subject: SUB },
    ]);
    signals = new SignalStackWriterFake();
    _setUserStore(store);
    _setOrganisationStore(orgs);
    _setIdentityStore(identities);
    _setIdpAdmin(idp);
    _setNetworkConfig(buildBlueDotConfig());
    _setSignalStackWriter(signals);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdentityStore(null);
    _setIdpAdmin(null);
    _setNetworkConfig(null);
    _setSignalStackWriter(null);
  });

  const approve = () => approveCoordinator({ userId: ID, decidedBy: ADMIN, log });
  const spyWrites = () => USER_WRITES.map((m) => vi.spyOn(idp, m));

  it('approves through the recorded login and writes nothing in Keycloak', async () => {
    const spies = spyWrites();
    const lookup = vi.spyOn(idp, 'findByAttribute');

    expect(await approve()).toEqual({ kind: 'approved' });

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(signals.listAggregators()).toHaveLength(1);
    const row = await store.findById(ID);
    expect(row.ok && row.value?.status).toBe('active');
    expect(row.ok && row.value?.signalstackOrgId).toBeTruthy();
  });

  it.each([
    ['fails in the database', 'unavailable'],
    ['loses to another decision', 'already_decided'],
  ] as const)(
    'makes no compensating Keycloak write when the compare-and-set %s',
    async (_label, kind) => {
      if (kind === 'unavailable') {
        store.approveFromPending = async () => ({
          ok: false,
          error: { code: 'DB_UNAVAILABLE', message: 'down' },
        });
      } else {
        const real = store.approveFromPending.bind(store);
        store.approveFromPending = async (id, by) => {
          await store.update(id, { status: 'inactive', updatedBy: 'other' });
          return real(id, by);
        };
      }
      const spies = spyWrites();

      expect((await approve()).kind).toBe(kind);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
  );

  it('provisions Keycloak as before for a legacy login whose user carries aggregator_id', async () => {
    await idp.setAttributes(SUB, { aggregator_id: ID });
    const enable = vi.spyOn(idp, 'enableUser');
    const decision = vi.spyOn(idp, 'setUserDecision');

    expect(await approve()).toEqual({ kind: 'approved' });

    expect(enable).toHaveBeenCalledWith(SUB);
    expect(decision).toHaveBeenCalledWith(SUB, 'approved');
  });

  it('answers unavailable when Keycloak cannot be read for the shared-login check', async () => {
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    const spies = spyWrites();

    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'idp' });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('answers unavailable when the identity store fails', async () => {
    const identities = new IdentityStoreFake();
    identities.accountsOf = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    identities.seed([
      { userId: ID, userType: 'coordinator', provider: IDP_PROVIDER, subject: SUB },
    ]);
    _setIdentityStore(identities);
    const spies = spyWrites();

    expect(await approve()).toEqual({ kind: 'unavailable', dependency: 'db' });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
