import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityStoreFake } from '../identity-store/testing.js';
import { _setIdentityStore } from '../identity-store/index.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { UserStoreFake, buildCoordinator } from '../user-store/testing.js';
import { _setUserStore } from '../user-store/index.js';
import { OrganisationStoreFake, buildOrganisation } from '../organisation-store/testing.js';
import { _setOrganisationStore } from '../organisation-store/index.js';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { resolveActingAccount } from './acting.js';

const SUB = 'kc-sub-1';
const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const COORD = '00000000-0000-0000-0000-0000000000c1';
const ORG = '00000000-0000-0000-0000-0000000000b1';

let identities: IdentityStoreFake;
let users: UserStoreFake;
let orgs: OrganisationStoreFake;

function seed(
  opts: { admin?: boolean; status?: AggregatorStatus; orgStatus?: AggregatorStatus } = {},
) {
  identities.registerAccount(COORD, 'coordinator');
  identities.seed([
    { userId: COORD, userType: 'coordinator', provider: IDP_PROVIDER, subject: SUB },
  ]);
  if (opts.admin !== false) {
    identities.seed([{ userId: ADMIN, userType: 'admin', provider: IDP_PROVIDER, subject: SUB }]);
  }
  users.seed([buildCoordinator({ id: COORD, status: opts.status ?? 'active', parentOrgId: ORG })]);
  orgs.seed([buildOrganisation({ id: ORG, status: opts.orgStatus ?? 'active' })]);
}

beforeEach(() => {
  identities = new IdentityStoreFake();
  users = new UserStoreFake();
  orgs = new OrganisationStoreFake();
  _setIdentityStore(identities);
  _setUserStore(users);
  _setOrganisationStore(orgs);
  return () => {
    _setIdentityStore(null);
    _setUserStore(null);
    _setOrganisationStore(null);
  };
});

describe('resolveActingAccount', () => {
  it('returns the coordinator row on the happy path', async () => {
    seed();
    const r = await resolveActingAccount(SUB, COORD);
    expect(r.success).toBe(true);
    if (r.success) expect(r.value.id).toBe(COORD);
  });

  it('NOT_LINKED when the account is not the login coordinator', async () => {
    seed();
    const r = await resolveActingAccount(SUB, '00000000-0000-0000-0000-0000000000c9');
    expect(r).toMatchObject({ success: false, error: { code: 'NOT_LINKED' } });
  });

  it('NOT_LINKED when an admin id is passed', async () => {
    seed();
    const r = await resolveActingAccount(SUB, ADMIN);
    expect(r).toMatchObject({ success: false, error: { code: 'NOT_LINKED' } });
  });

  it('NOT_SHARED_LOGIN when the login has no admin account', async () => {
    seed({ admin: false });
    const r = await resolveActingAccount(SUB, COORD);
    expect(r).toMatchObject({ success: false, error: { code: 'NOT_SHARED_LOGIN' } });
  });

  it.each<AggregatorStatus>(['pending', 'inactive', 'retired'])(
    'INACTIVE when the coordinator is %s',
    async (status) => {
      seed({ status });
      const r = await resolveActingAccount(SUB, COORD);
      expect(r).toMatchObject({ success: false, error: { code: 'INACTIVE' } });
    },
  );

  it('INACTIVE when the coordinator row is missing', async () => {
    seed();
    users.reset();
    const r = await resolveActingAccount(SUB, COORD);
    expect(r).toMatchObject({ success: false, error: { code: 'INACTIVE' } });
  });

  it('INACTIVE when the org is not active', async () => {
    seed({ orgStatus: 'inactive' });
    const r = await resolveActingAccount(SUB, COORD);
    expect(r).toMatchObject({ success: false, error: { code: 'INACTIVE' } });
  });

  it('UNAVAILABLE when the identity store fails', async () => {
    seed();
    identities.accountsOf = () =>
      Promise.resolve({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'x' } });
    const r = await resolveActingAccount(SUB, COORD);
    expect(r).toMatchObject({ success: false, error: { code: 'UNAVAILABLE' } });
  });
});
