import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import type { SelfAddRequest } from '@aggregator-dpg/shared-primitives/user-org';
import { err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../user-store/index.js';
import {
  OrganisationStoreFake,
  buildDefaultOrg,
  buildOrganisation,
  _setOrganisationStore,
} from '../organisation-store/index.js';
import { IdpAdminFake, KC_ATTR, _setIdpAdmin } from '../idp-admin/index.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { IdentityStoreFake } from '../identity-store/testing.js';
import { _setIdentityStore } from '../identity-store/index.js';
import { _setConsentLedger } from '../consent-ledger/index.js';
import { _setNetworkConfig } from '../network-config.js';
import { _setSignalStackWriter } from '../signalstack.js';
import { buildAdminActor } from '../auth/actor/testing.js';
import type { Actor } from '../auth/actor/index.js';
import { ownerSelfAdd } from './owner-self-add.js';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const ROOT = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-0000000000f1';
const ORG_2 = '00000000-0000-4000-8000-0000000000f2';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000f3';
const SUB = 'kc-owner-sub';
const EMAIL = 'owner@org.test';
const PHONE = '+919000000001';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

const owned = (id: string) => ({
  id,
  orgType: 'aggregator' as const,
  relation: 'owner' as const,
  isDefault: false,
});

const CONSENT = {
  value: true as const,
  given_at: '2026-11-19T00:00:00.000Z',
  valid_till: '2027-11-19T00:00:00.000Z',
};

/** Every Keycloak user write a coordinator path could make. */
const USER_WRITES = [
  'enableUser',
  'disableUser',
  'setUserDecision',
  'setAttributes',
  'logoutSessions',
  'createUser',
] as const;

describe('ownerSelfAdd', () => {
  let users: UserStoreFake;
  let orgs: OrganisationStoreFake;
  let identities: IdentityStoreFake;
  let idp: IdpAdminFake;
  let signals: SignalStackWriterFake;
  let ledger: ConsentLedgerFake;
  let actor: Actor;

  const ownerOrg = (id: string, extra: Parameters<typeof buildOrganisation>[0] = {}) =>
    buildOrganisation({
      id,
      parentId: ROOT,
      slug: `org-${id.slice(-2)}`,
      displayName: `Org ${id.slice(-2)}`,
      status: 'active',
      ownerUserId: ADMIN,
      ownerEmail: EMAIL,
      ownerPhone: PHONE,
      ownerName: 'Owner Person',
      ...extra,
    });

  beforeEach(() => {
    users = new UserStoreFake();
    orgs = new OrganisationStoreFake();
    orgs.seedRoot(
      buildOrganisation({
        id: ROOT,
        slug: 'network',
        status: 'active',
        ownerUserId: 'na',
        depth: 0,
      }),
    );
    orgs.seed([
      ownerOrg(ORG),
      ownerOrg(ORG_2),
      buildOrganisation({ id: OTHER_ORG, status: 'active', ownerUserId: 'someone-else' }),
      { ...buildDefaultOrg(), ownerUserId: ADMIN, status: 'active' },
    ]);
    identities = new IdentityStoreFake();
    identities.seed([{ userId: ADMIN, userType: 'admin', provider: IDP_PROVIDER, subject: SUB }]);
    idp = new IdpAdminFake();
    signals = new SignalStackWriterFake();
    ledger = new ConsentLedgerFake();
    actor = buildAdminActor({ userId: ADMIN, orgs: [owned(ORG), owned(ORG_2)] });
    _setUserStore(users);
    _setOrganisationStore(orgs);
    _setIdentityStore(identities);
    _setIdpAdmin(idp);
    _setNetworkConfig(buildBlueDotConfig());
    _setSignalStackWriter(signals);
    _setConsentLedger(ledger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _setUserStore(null);
    _setOrganisationStore(null);
    _setIdentityStore(null);
    _setIdpAdmin(null);
    _setNetworkConfig(null);
    _setSignalStackWriter(null);
    _setConsentLedger(null);
  });

  const input = (overrides: Partial<SelfAddRequest> = {}): SelfAddRequest => ({
    org_id: ORG,
    serves: ['seeker'],
    consent: CONSENT,
    ...overrides,
  });
  const selfAdd = (req: SelfAddRequest = input(), who: Actor = actor) =>
    ownerSelfAdd(who, SUB, req, log);
  const errorCode = async (req: SelfAddRequest, who: Actor = actor) => {
    const out = await selfAdd(req, who);
    return out.success ? 'ok' : out.error.code;
  };

  it('creates an approved coordinator on the owner contact, linked to the same login, with no Keycloak write', async () => {
    const spies = USER_WRITES.map((m) => vi.spyOn(idp, m));

    const out = await selfAdd();

    if (!out.success) throw new Error(`self-add failed: ${out.error.code}`);
    const row = out.value;
    expect(row.parentOrgId).toBe(ORG);
    expect(row.serves).toEqual(['seeker']);
    expect(row.contactEmail).toBe(EMAIL);
    expect(row.contactPhone).toBe(PHONE);
    expect(row.name).toBe('Owner Person');
    expect(row.status).toBe('active');
    expect(row.signalstackOrgId).toBeTruthy();
    expect(row.updatedBy).toBe(ADMIN);
    expect(await identities.accountsOf(IDP_PROVIDER, SUB)).toEqual({
      ok: true,
      value: { admin: ADMIN, coordinator: row.id },
    });
    expect(signals.listAggregators().map((a) => a.external_id)).toEqual([row.id]);
    expect(ledger.list()).toHaveLength(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('refuses the Default org', async () => {
    const a = buildAdminActor({
      userId: ADMIN,
      orgs: [owned(ORG), { ...owned(buildDefaultOrg().id), isDefault: true }],
    });
    expect(await errorCode(input({ org_id: buildDefaultOrg().id }), a)).toBe('ORG_NOT_ELIGIBLE');
  });

  it('refuses an owner of the root', async () => {
    const a = buildAdminActor({
      userId: ADMIN,
      orgs: [
        { id: ROOT, orgType: 'network_facilitator', relation: 'owner', isDefault: false },
        owned(ORG),
      ],
    });
    expect(await errorCode(input(), a)).toBe('ORG_NOT_ELIGIBLE');
  });

  it('does not treat a non-owner relation to the root as owning it', async () => {
    const a = buildAdminActor({
      userId: ADMIN,
      orgs: [
        { id: ROOT, orgType: 'network_facilitator', relation: 'member', isDefault: false },
        owned(ORG),
      ],
    });
    expect(await errorCode(input(), a)).toBe('ok');
  });

  it('refuses an owner contact with no phone with OWNER_PHONE_REQUIRED', async () => {
    orgs.seed([ownerOrg(ORG, { ownerPhone: null })]);
    expect(await errorCode(input())).toBe('OWNER_PHONE_REQUIRED');
  });

  it('refuses an org that is not active', async () => {
    orgs.seed([ownerOrg(ORG, { status: 'pending' })]);
    expect(await errorCode(input())).toBe('ORG_NOT_ELIGIBLE');
  });

  it.each([
    ['an org owned by someone else', OTHER_ORG],
    ['an unknown org', '00000000-0000-4000-8000-0000000000ff'],
    ['the root', ROOT],
  ])('refuses %s with NOT_ORG_OWNER', async (_label, orgId) => {
    expect(await errorCode(input({ org_id: orgId }))).toBe('NOT_ORG_OWNER');
  });

  it('refuses a coordinator caller with NOT_ORG_OWNER', async () => {
    expect(await errorCode(input(), { ...actor, userType: 'coordinator' })).toBe('NOT_ORG_OWNER');
  });

  it('refuses profile types the network does not have', async () => {
    expect(await errorCode(input({ serves: ['not-a-domain'] }))).toBe('NO_PROFILE_TYPES');
    expect(await errorCode(input({ serves: ['seeker', 'not-a-domain'] }))).toBe('NO_PROFILE_TYPES');
  });

  it.each([
    ['the same org', ORG],
    ['another org', ORG_2],
  ])('refuses a second self-add in %s', async (_label, orgId) => {
    expect((await selfAdd()).success).toBe(true);
    expect(await errorCode(input({ org_id: orgId }))).toBe('ALREADY_COORDINATOR');
  });

  it('reactivates a non-active self account in the same org', async () => {
    const first = await selfAdd();
    if (!first.success) throw new Error('seed failed');
    await users.update(first.value.id, { status: 'inactive', updatedBy: 'test' });
    const spies = USER_WRITES.map((m) => vi.spyOn(idp, m));

    const again = await selfAdd(input({ serves: ['seeker', 'provider'] }));

    if (!again.success) throw new Error(`reactivation failed: ${again.error.code}`);
    expect(again.value.id).toBe(first.value.id);
    expect(again.value.status).toBe('active');
    expect(again.value.serves).toEqual(['seeker', 'provider']);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(ledger.list()).toHaveLength(2);
    expect(ledger.list()[1]).toMatchObject({ subjectId: first.value.id });
  });

  it('leaves the row unchanged when linking the login fails during reactivation', async () => {
    const first = await selfAdd();
    if (!first.success) throw new Error('seed failed');
    await users.update(first.value.id, { status: 'inactive', updatedBy: 'test' });
    // A row with no recorded login yet, whose link then fails.
    const bare = new IdentityStoreFake();
    bare.seed([{ userId: ADMIN, userType: 'admin', provider: IDP_PROVIDER, subject: SUB }]);
    bare.link = async () => ({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'down' } });
    _setIdentityStore(bare);

    expect(await errorCode(input({ serves: ['seeker', 'provider'] }))).toBe('UNAVAILABLE');

    const row = await users.findById(first.value.id);
    expect(row.ok && row.value?.status).toBe('inactive');
    expect(row.ok && row.value?.serves).toEqual(['seeker']);
    expect(ledger.list()).toHaveLength(1);
  });

  it('refuses to reactivate a row that has its own Keycloak user', async () => {
    const first = await selfAdd();
    if (!first.success) throw new Error('seed failed');
    await users.update(first.value.id, { status: 'inactive', updatedBy: 'test' });
    await idp.createUser({
      email: 'legacy@x.test',
      enabled: false,
      attributes: { [KC_ATTR.AGGREGATOR_ID]: first.value.id },
    });

    expect(await errorCode(input())).toBe('ALREADY_COORDINATOR');
    const row = await users.findById(first.value.id);
    expect(row.ok && row.value?.status).toBe('inactive');
  });

  it('refuses to reactivate a non-active self account from another org', async () => {
    const first = await selfAdd();
    if (!first.success) throw new Error('seed failed');
    await users.update(first.value.id, { status: 'inactive', updatedBy: 'test' });
    expect(await errorCode(input({ org_id: ORG_2 }))).toBe('ALREADY_COORDINATOR');
  });

  it('refuses a coordinator row on the owner contact that belongs to another login', async () => {
    users.seed([
      buildCoordinator({
        id: '00000000-0000-4000-8000-0000000000c9',
        status: 'inactive',
        parentOrgId: ORG,
        isDefaultOrg: false,
        contactEmail: EMAIL,
        contactPhone: PHONE,
        contact: { name: 'Owner Person', email: EMAIL, phone: PHONE },
      }),
    ]);
    identities.seed([
      {
        userId: '00000000-0000-4000-8000-0000000000c9',
        userType: 'coordinator',
        provider: IDP_PROVIDER,
        subject: 'another-login',
      },
    ]);
    expect(await errorCode(input())).toBe('ALREADY_COORDINATOR');
  });

  it('deletes the new row and answers UNAVAILABLE when the identity link fails', async () => {
    identities.link = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const deleted = vi.spyOn(users, 'deleteById');

    expect(await errorCode(input())).toBe('UNAVAILABLE');

    expect(deleted).toHaveBeenCalledTimes(1);
    const left = await users.findByContactEmail(EMAIL);
    expect(left.ok && left.value).toBeNull();
    expect(signals.listAggregators()).toHaveLength(0);
  });

  it('answers UNAVAILABLE and leaves the row pending when Signals fails, and a retry approves it', async () => {
    const failing = new SignalStackWriterFake();
    failing.upsertAggregator = async () => err(new UpstreamError('down', { code: 'SS_DOWN' }));
    _setSignalStackWriter(failing);

    expect(await errorCode(input())).toBe('UNAVAILABLE');
    const pending = await users.findByContactEmail(EMAIL);
    expect(pending.ok && pending.value?.status).toBe('pending');

    _setSignalStackWriter(signals);
    const retry = await selfAdd();
    expect(retry.success && retry.value.status).toBe('active');
  });

  it('answers UNAVAILABLE when the organisation store fails', async () => {
    orgs.findById = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    expect(await errorCode(input())).toBe('UNAVAILABLE');
  });
});
