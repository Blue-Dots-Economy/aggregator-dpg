/**
 * Tests for the acting-account path of `requireApproved`: an org owner acting
 * as its own coordinator account on the same login (`x-acting-account`).
 *
 * @module @aggregator-dpg/api
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ACTING_ACCOUNT_HEADER } from '@aggregator-dpg/shared-primitives/user-org';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import {
  authenticate,
  requireApproved,
  _setAccessTokenVerifier,
  _resetJwks,
} from './access-token.js';
import { IdentityStoreFake } from '../identity-store/testing.js';
import { _setIdentityStore } from '../identity-store/index.js';
import { _resetRecordedIdentities } from '../identity-store/record.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { IdpAdminFake, _setIdpAdmin } from '../idp-admin/index.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../user-store/index.js';
import { OrganisationStoreFake, buildOrganisation } from '../organisation-store/testing.js';
import { _setOrganisationStore } from '../organisation-store/index.js';
import { _setSignalStackWriter } from '../signalstack.js';
import { _setNetworkConfig } from '../network-config.js';

const SUB = 'kc-owner-1';
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const COORD = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const ORG = '00000000-0000-4000-8000-0000000000b1';

/** Owner token: no `aggregator_id`, owner-only claims that must not leak into the context. */
const OWNER_CLAIMS = {
  sub: SUB,
  email: 'owner@example.org',
  given_name: 'Asha',
  family_name: 'Rao',
  phone_number: '+919800000000',
  azp: 'aggregator-portal',
  aggregator_type: ['provider'],
  signalstack_org_id: 'org_from_token',
};

function makeReq(claims: Record<string, unknown>, acting?: string): FastifyRequest {
  _setAccessTokenVerifier(async () => claims);
  return {
    headers: {
      authorization: 'Bearer stub',
      ...(acting === undefined ? {} : { [ACTING_ACCOUNT_HEADER]: acting }),
    },
  } as unknown as FastifyRequest;
}

describe('requireApproved acting as an owner coordinator account', () => {
  let identities: IdentityStoreFake;
  let users: UserStoreFake;
  let orgs: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let writer: SignalStackWriterFake;

  function seed(opts: { signalstackOrgId?: string | null; status?: 'active' | 'inactive' } = {}) {
    identities.seed([
      { userId: COORD, userType: 'coordinator', provider: IDP_PROVIDER, subject: SUB },
      { userId: ADMIN, userType: 'admin', provider: IDP_PROVIDER, subject: SUB },
    ]);
    users.seed([
      buildCoordinator({
        id: COORD,
        status: opts.status ?? 'active',
        parentOrgId: ORG,
        serves: ['seeker'],
        signalstackOrgId:
          opts.signalstackOrgId === undefined ? 'org_from_row' : opts.signalstackOrgId,
      }),
    ]);
    orgs.seed([buildOrganisation({ id: ORG, status: 'active' })]);
  }

  beforeEach(() => {
    _resetJwks();
    _resetRecordedIdentities();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'bluedots';
    identities = new IdentityStoreFake();
    users = new UserStoreFake();
    orgs = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    writer = new SignalStackWriterFake();
    _setIdentityStore(identities);
    _setUserStore(users);
    _setOrganisationStore(orgs);
    _setIdpAdmin(idp);
    _setSignalStackWriter(writer);
    _setNetworkConfig(buildBlueDotConfig());
  });

  afterEach(() => {
    _setAccessTokenVerifier(null);
    _setIdentityStore(null);
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
  });

  it('(a) builds the context from the row and skips the backfill and login record', async () => {
    seed();
    const setAttributes = vi.spyOn(idp, 'setAttributes');
    const link = vi.spyOn(identities, 'link');
    const r = await requireApproved(makeReq(OWNER_CLAIMS, COORD));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context).toMatchObject({
      userId: SUB,
      aggregatorId: COORD,
      serves: ['seeker'],
      decisionMade: 'approved',
      signalstackOrgId: 'org_from_row',
      email: 'owner@example.org',
      firstName: 'Asha',
      lastName: 'Rao',
      phoneNumber: '+919800000000',
      azp: 'aggregator-portal',
    });
    expect(setAttributes).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    expect(writer.listAggregators()).toHaveLength(0);
  });

  it('(b) 403 ACTING_ACCOUNT_INVALID for an account not linked to this login', async () => {
    seed();
    const r = await requireApproved(makeReq(OWNER_CLAIMS, OTHER));
    expect(r).toMatchObject({ ok: false, error: { code: 'ACTING_ACCOUNT_INVALID' } });
  });

  it('(b) 403 ACTING_ACCOUNT_INVALID for a deactivated coordinator row', async () => {
    seed({ status: 'inactive' });
    const r = await requireApproved(makeReq(OWNER_CLAIMS, COORD));
    expect(r).toMatchObject({ ok: false, error: { code: 'ACTING_ACCOUNT_INVALID' } });
  });

  it('(b) 403 ACTING_ACCOUNT_INVALID for a malformed header value', async () => {
    seed();
    const r = await requireApproved(makeReq(OWNER_CLAIMS, 'not-a-guid'));
    expect(r).toMatchObject({ ok: false, error: { code: 'ACTING_ACCOUNT_INVALID' } });
  });

  it('(b) 403 ACTING_ACCOUNT_INVALID when the login holds no owner account', async () => {
    identities.seed([
      { userId: COORD, userType: 'coordinator', provider: IDP_PROVIDER, subject: SUB },
    ]);
    users.seed([buildCoordinator({ id: COORD, status: 'active', parentOrgId: ORG })]);
    orgs.seed([buildOrganisation({ id: ORG, status: 'active' })]);
    const r = await requireApproved(makeReq(OWNER_CLAIMS, COORD));
    expect(r).toMatchObject({ ok: false, error: { code: 'ACTING_ACCOUNT_INVALID' } });
  });

  it('reports ACTING_UNAVAILABLE when a store fails', async () => {
    seed();
    identities.accountsOf = () =>
      Promise.resolve({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'down' } });
    const r = await requireApproved(makeReq(OWNER_CLAIMS, COORD));
    expect(r).toMatchObject({ ok: false, error: { code: 'ACTING_UNAVAILABLE' } });
  });

  it('(c) NOT_APPROVED when the row has no signalstack_org_id, with no backfill', async () => {
    seed({ signalstackOrgId: null });
    const setAttributes = vi.spyOn(idp, 'setAttributes');
    const r = await requireApproved(makeReq(OWNER_CLAIMS, COORD));
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_APPROVED' } });
    expect(setAttributes).not.toHaveBeenCalled();
    expect(writer.listAggregators()).toHaveLength(0);
  });

  it('(d) 403 for a coordinator token whose header differs from its claim', async () => {
    seed();
    const claims = {
      sub: SUB,
      aggregator_id: COORD,
      decision_made: 'approved',
      signalstack_org_id: 'org_x',
    };
    const r = await requireApproved(makeReq(claims, OTHER));
    expect(r).toMatchObject({ ok: false, error: { code: 'ACTING_ACCOUNT_INVALID' } });
  });

  it('(d) a coordinator token whose header equals its claim behaves as today', async () => {
    seed();
    const claims = {
      sub: SUB,
      aggregator_id: COORD,
      decision_made: 'approved',
      signalstack_org_id: 'org_x',
    };
    const r = await requireApproved(makeReq(claims, COORD));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.context.signalstackOrgId).toBe('org_x');
  });

  it('(e) MISSING_AGGREGATOR_ID with no claim and no header', async () => {
    seed();
    const r = await requireApproved(makeReq(OWNER_CLAIMS));
    expect(r).toMatchObject({ ok: false, error: { code: 'MISSING_AGGREGATOR_ID' } });
  });

  it('(i) authenticate alone does not accept acting', async () => {
    seed();
    const r = await authenticate(makeReq(OWNER_CLAIMS, COORD));
    expect(r).toMatchObject({ ok: false, error: { code: 'MISSING_AGGREGATOR_ID' } });
  });
});
