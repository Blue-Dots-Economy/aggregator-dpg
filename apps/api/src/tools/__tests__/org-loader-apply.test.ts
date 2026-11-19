import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err } from '@aggregator-dpg/shared-primitives/result';
import type { CreateUserInput } from '../../services/idp-admin/interface.js';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../../services/organisation-store/index.js';
import { UserStoreFake, _setUserStore } from '../../services/user-store/index.js';
import { IdpAdminFake, KC_ATTR, _setIdpAdmin } from '../../services/idp-admin/index.js';
import { _setConsentLedger } from '../../services/consent-ledger/index.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { _setSignalStackWriter } from '../../services/signalstack.js';
import { OWNER_ROLE } from '../../services/decisions/org.js';
import type { CoordinatorRow, OrgRow } from '../org-loader-input.js';
import { buildLoadPlan, type LoadPlan } from '../org-loader-plan.js';
import { applyLoadPlan, type ReportRow } from '../org-loader-apply.js';

vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'nf-admin@test.local';
});

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
/** Sorts ids as text; a missing id sorts as ''. */
const byText = (a: string | null | undefined, b: string | null | undefined): number =>
  (a ?? '').localeCompare(b ?? '');
const ROOT = '00000000-0000-4000-8000-000000000001';
const OPERATOR = 'ops';
const PROVISIONED = 'provisioned:ops';
const OWNER_EMAIL = 'ravi@alpha.org';
const TREE_RULES = { maxDepth: 5, maxChildren: null, maxTotalOrgs: 50 };

/** Fails `createUser` for one email until {@link failFor} is cleared. */
class FlakyIdp extends IdpAdminFake {
  failFor: string | null = null;
  failRole = false;
  failDecision = false;

  override async setUserDecision(
    userId: string,
    decision: 'pending' | 'approved' | 'rejected' | 'invited',
  ) {
    if (this.failDecision) {
      return { ok: false as const, error: { code: 'IDP_UNAVAILABLE' as const, message: 'down' } };
    }
    return super.setUserDecision(userId, decision);
  }

  override async createUser(input: CreateUserInput) {
    if (this.failFor === input.email) {
      return { ok: false as const, error: { code: 'IDP_UNAVAILABLE' as const, message: 'down' } };
    }
    return super.createUser(input);
  }

  override async assignRealmRole(userId: string, role: string) {
    if (this.failRole) {
      return { ok: false as const, error: { code: 'IDP_UNAVAILABLE' as const, message: 'down' } };
    }
    return super.assignRealmRole(userId, role);
  }
}

/** Signals writer whose `upsertAggregator` fails while {@link down} is set. */
class FlakySignals extends SignalStackWriterFake {
  down = false;

  override async upsertAggregator(...args: Parameters<SignalStackWriterFake['upsertAggregator']>) {
    if (this.down) return err(new UpstreamError('down', { code: 'SIGNALSTACK_UNAVAILABLE' }));
    return super.upsertAggregator(...args);
  }
}

/** Org store whose `approve` throws while {@link throwOnApprove} is set. */
class ThrowingOrgStore extends OrganisationStoreFake {
  throwOnApprove = false;

  override async approve(id: string, updatedBy: string) {
    if (this.throwOnApprove) throw new TypeError('boom');
    return super.approve(id, updatedBy);
  }
}

let orgStore: ThrowingOrgStore;
let userStore: UserStoreFake;
let idp: FlakyIdp;
let signals: FlakySignals;
let ledger: ConsentLedgerFake;
let mailer: FakeMailer;
let nextLine = 2;

function orgRow(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    line: nextLine++,
    name: 'Top',
    parent: null,
    owner: { name: 'Ravi Kumar', email: OWNER_EMAIL, phone: '9876500001' },
    extra: {},
    address: {},
    ...overrides,
  };
}

function coordRow(overrides: Partial<CoordinatorRow> = {}): CoordinatorRow {
  return {
    line: nextLine++,
    org: 'Top',
    name: 'Asha Kumari',
    email: 'asha@alpha.org',
    phone: '9876511111',
    profileTypes: ['seeker'],
    extra: {},
    ...overrides,
  };
}

/** A two-level tree, one owner on both orgs, and coordinators in each. */
function treeRows(coordinatorCount = 2): { orgs: OrgRow[]; coordinators: CoordinatorRow[] } {
  const orgs = [orgRow({ name: 'Top' }), orgRow({ name: 'Child', parent: 'Top' })];
  const coordinators = [
    coordRow({ org: 'Top', name: 'Asha', email: 'asha@alpha.org', phone: '9876511111' }),
    coordRow({ org: 'Child', name: 'Bina', email: 'bina@alpha.org', phone: '9876511112' }),
    coordRow({ org: 'Child', name: 'Chetan', email: 'chetan@alpha.org', phone: '9876511113' }),
  ].slice(0, coordinatorCount);
  return { orgs, coordinators };
}

async function plan(rows: { orgs: OrgRow[]; coordinators: CoordinatorRow[] }): Promise<LoadPlan> {
  const p = await buildLoadPlan(rows);
  expect(p.problems).toEqual([]);
  return p;
}

async function apply(rows: { orgs: OrgRow[]; coordinators: CoordinatorRow[] }) {
  return applyLoadPlan(await plan(rows), { operator: OPERATOR, log });
}

function outcomes(rows: ReportRow[]): string[] {
  return rows.map((r) => `${r.kind}:${r.name}:${r.outcome}`);
}

async function orgByName(name: string) {
  const page = await orgStore.search({ orgIds: null, namePrefix: name, limit: 10 });
  if (!page.ok) throw new Error('search failed');
  return page.value.rows.find((o) => o.displayName === name);
}

async function coordinatorByEmail(email: string) {
  const r = await userStore.findByContactEmail(email);
  if (!r.ok) throw new Error('lookup failed');
  return r.value;
}

async function kcUser(sub: string) {
  const r = await idp.findById(sub);
  if (!r.ok || !r.value) throw new Error('no kc user');
  return r.value;
}

beforeEach(() => {
  nextLine = 2;
  orgStore = new ThrowingOrgStore();
  orgStore.seedRoot(
    buildOrganisation({
      id: ROOT,
      displayName: 'Blue Dots Network',
      depth: 0,
      status: 'active',
      ownerEmail: 'nf-admin@test.local',
    }),
  );
  _setOrganisationStore(orgStore);
  userStore = new UserStoreFake();
  _setUserStore(userStore);
  idp = new FlakyIdp();
  _setIdpAdmin(idp);
  signals = new FlakySignals();
  _setSignalStackWriter(signals);
  ledger = new ConsentLedgerFake();
  _setConsentLedger(ledger);
  mailer = new FakeMailer();
  _setMailer(mailer);
  const base = buildBlueDotConfig();
  _setNetworkConfig(
    buildBlueDotConfig({
      aggregator: {
        ...base.aggregator,
        organisation: { hierarchy: { max_depth: 5, max_total_orgs: 50 } },
      },
    }),
  );
});

afterEach(() => {
  _setSignalStackWriter(null);
  _setConsentLedger(null);
  _setNetworkConfig(null);
});

describe('applyLoadPlan: a fresh load', () => {
  it('creates and activates a two-level tree with one owner and two coordinators', async () => {
    const result = await apply(treeRows());

    expect(result.failed).toBe(false);
    expect(outcomes(result.rows)).toEqual([
      'org:Top:created',
      'org:Child:created',
      'coordinator:Asha:created',
      'coordinator:Bina:created',
    ]);

    const top = await orgByName('Top');
    const child = await orgByName('Child');
    expect(top?.status).toBe('active');
    expect(child?.status).toBe('active');
    expect(child?.parentId).toBe(top?.id);
    expect(top?.createdBy).toBe(PROVISIONED);
    expect(top?.updatedBy).toBe(PROVISIONED);
    // One owner, one Keycloak user, on both orgs.
    expect(top?.ownerUserId).toBe(child?.ownerUserId);
    expect(top?.ownerKcSub).toBeTruthy();
    expect(child?.ownerKcSub).toBe(top?.ownerKcSub);
    const owner = await kcUser(top?.ownerKcSub ?? '');
    expect(owner.enabled).toBe(true);
    expect(owner.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['approved']);
    expect(idp.rolesOf(owner.id)).toContain(OWNER_ROLE);
    expect(idp.groupsOf(owner.id).sort(byText)).toEqual(
      [top?.kcGroupId, child?.kcGroupId].sort(byText),
    );

    const asha = await coordinatorByEmail('asha@alpha.org');
    const bina = await coordinatorByEmail('bina@alpha.org');
    expect(asha?.status).toBe('active');
    expect(bina?.status).toBe('active');
    expect(asha?.parentOrgId).toBe(top?.id);
    expect(bina?.parentOrgId).toBe(child?.id);
    expect(asha?.createdBy).toBe(PROVISIONED);
    expect(asha?.signalstackOrgId).toBeTruthy();
    const ashaKc = await idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, asha?.id ?? '');
    expect(ashaKc.ok && ashaKc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['approved']);

    expect(signals.listAggregators()).toHaveLength(2);
    expect(ledger.list()).toHaveLength(0);
    expect(mailer.outbox).toHaveLength(0);

    // The report carries the ids and the role sync outcome ('off' without the RBAC runtime).
    expect(result.rows[0]).toMatchObject({
      kind: 'org',
      email: OWNER_EMAIL,
      orgId: top?.id,
      userId: top?.ownerUserId,
      rolesSync: 'off',
    });
    expect(result.rows[2]).toMatchObject({
      kind: 'coordinator',
      email: 'asha@alpha.org',
      orgId: top?.id,
      userId: asha?.id,
      signalsOrgId: asha?.signalstackOrgId,
      rolesSync: 'off',
    });
  });

  it('marks every row already_loaded on a rerun', async () => {
    const rows = treeRows();
    await apply(rows);
    const again = await apply(rows);
    expect(again.failed).toBe(false);
    expect(again.rows.map((r) => r.outcome)).toEqual([
      'already_loaded',
      'already_loaded',
      'already_loaded',
      'already_loaded',
    ]);
    const top = await orgByName('Top');
    expect(again.rows[0]).toMatchObject({ orgId: top?.id, userId: top?.ownerUserId });
    expect(again.rows[2]?.signalsOrgId).toBeTruthy();
    expect(signals.listAggregators()).toHaveLength(2);
  });

  it('refuses a plan with problems before writing anything', async () => {
    const p: LoadPlan = {
      orgs: [],
      coordinators: [],
      problems: [{ file: 'orgs', line: 2, code: 'UNKNOWN_PARENT', field: 'parent' }],
    };
    await expect(applyLoadPlan(p, { operator: OPERATOR, log })).rejects.toMatchObject({
      code: 'PLAN_HAS_PROBLEMS',
    });
  });
});

describe('applyLoadPlan: stopping and resuming', () => {
  it('stops at the failed coordinator, marks the rest not_run, and a rerun finishes', async () => {
    const rows = treeRows(3);
    idp.failFor = 'bina@alpha.org';
    const first = await apply(rows);
    expect(first.failed).toBe(true);
    expect(outcomes(first.rows)).toEqual([
      'org:Top:created',
      'org:Child:created',
      'coordinator:Asha:created',
      'coordinator:Bina:failed',
      'coordinator:Chetan:not_run',
    ]);
    expect(first.rows[3]?.errorCode).toBe('IDP_UNAVAILABLE');
    expect(await coordinatorByEmail('bina@alpha.org')).toBeNull();
    expect(await coordinatorByEmail('chetan@alpha.org')).toBeNull();

    idp.failFor = null;
    const second = await apply(rows);
    expect(second.failed).toBe(false);
    expect(outcomes(second.rows)).toEqual([
      'org:Top:already_loaded',
      'org:Child:already_loaded',
      'coordinator:Asha:already_loaded',
      'coordinator:Bina:created',
      'coordinator:Chetan:created',
    ]);
    expect((await coordinatorByEmail('bina@alpha.org'))?.status).toBe('active');
  });

  it('creates the coordinators on a rerun after a run that stopped once the orgs were approved', async () => {
    const rows = treeRows();
    const orgsOnly = await apply({ orgs: rows.orgs, coordinators: [] });
    expect(orgsOnly.rows.map((r) => r.outcome)).toEqual(['created', 'created']);

    const rerun = await apply(rows);
    expect(outcomes(rerun.rows)).toEqual([
      'org:Top:already_loaded',
      'org:Child:already_loaded',
      'coordinator:Asha:created',
      'coordinator:Bina:created',
    ]);
  });

  it('resumes a coordinator left pending when Signals failed', async () => {
    const rows = treeRows();
    signals.down = true;
    const first = await apply(rows);
    expect(outcomes(first.rows)).toEqual([
      'org:Top:created',
      'org:Child:created',
      'coordinator:Asha:failed',
      'coordinator:Bina:not_run',
    ]);
    expect(first.rows[2]?.errorCode).toBe('SIGNALSTACK_UNAVAILABLE');
    const pending = await coordinatorByEmail('asha@alpha.org');
    expect(pending?.status).toBe('pending');

    signals.down = false;
    const second = await apply(rows);
    expect(outcomes(second.rows)).toEqual([
      'org:Top:already_loaded',
      'org:Child:already_loaded',
      'coordinator:Asha:resumed',
      'coordinator:Bina:created',
    ]);
    const asha = await coordinatorByEmail('asha@alpha.org');
    expect(asha?.id).toBe(pending?.id);
    expect(asha?.status).toBe('active');
  });

  it('catches a thrown error, fails that row and resumes the pending org on a rerun', async () => {
    const rows = treeRows();
    orgStore.throwOnApprove = true;
    const first = await apply(rows);
    expect(first.failed).toBe(true);
    expect(outcomes(first.rows)).toEqual([
      'org:Top:failed',
      'org:Child:not_run',
      'coordinator:Asha:not_run',
      'coordinator:Bina:not_run',
    ]);
    expect(first.rows[0]?.errorCode).toBe('UNEXPECTED');
    const pending = await orgByName('Top');
    expect(pending?.status).toBe('pending');

    orgStore.throwOnApprove = false;
    const second = await apply(rows);
    expect(second.failed).toBe(false);
    expect(outcomes(second.rows)).toEqual([
      'org:Top:resumed',
      'org:Child:created',
      'coordinator:Asha:created',
      'coordinator:Bina:created',
    ]);
    const top = await orgByName('Top');
    expect(top?.id).toBe(pending?.id);
    expect(top?.status).toBe('active');
    // The child reused the owner login created for Top in the first run.
    expect((await orgByName('Child'))?.ownerKcSub).toBe(top?.ownerKcSub);
  });

  it('recreates a half-created org, removing only the group linked by id', async () => {
    const created = await orgStore.create(
      {
        slug: 'top-old',
        displayName: 'Top',
        ownerEmail: OWNER_EMAIL,
        ownerPhone: '+919876500001',
        ownerName: 'Ravi Kumar',
        createdBy: PROVISIONED,
      },
      TREE_RULES,
    );
    if (!created.ok) throw new Error('seed failed');
    const group = await idp.createGroup('org-top-old', { org_id: created.value.id });
    if (!group.ok) throw new Error('seed failed');
    await orgStore.update(created.value.id, { kcGroupId: group.value.id });
    // An unrelated user with no link to the org stays.
    await idp.createUser({ email: 'someone@else.org', username: 'someone@else.org' });

    const rows = treeRows(0);
    const result = await apply({ orgs: rows.orgs.slice(0, 1), coordinators: [] });
    expect(outcomes(result.rows)).toEqual(['org:Top:resumed']);
    const top = await orgByName('Top');
    expect(top?.id).not.toBe(created.value.id);
    expect(top?.status).toBe('active');
    expect(top?.ownerKcSub).toBeTruthy();
    // The fake reuses group ids, so the old group is checked by name.
    const oldGroup = await idp.findGroupByName('org-top-old');
    expect(oldGroup.ok && oldGroup.value).toBeNull();
    expect(top?.kcGroupId).toBeTruthy();
    const other = await idp.findByEmail('someone@else.org');
    expect(other.ok && other.value).toBeTruthy();
    expect(result.rows[0]?.orgId).toBe(top?.id);
  });

  /** Seeds a pending provisioned "Top" with no group, optionally stamped with an owner login. */
  async function seedHalfCreatedTop(ownerKcSub?: string) {
    const created = await orgStore.create(
      {
        slug: 'top-old',
        displayName: 'Top',
        ownerEmail: OWNER_EMAIL,
        ownerPhone: '+919876500001',
        ownerName: 'Ravi Kumar',
        createdBy: PROVISIONED,
      },
      TREE_RULES,
    );
    if (!created.ok) throw new Error('seed failed');
    if (ownerKcSub) await orgStore.update(created.value.id, { kcGroupId: null, ownerKcSub });
    return created.value;
  }

  it('removes the owner login linked by id to a half-created org and creates a new one', async () => {
    const old = await idp.createUser({ email: OWNER_EMAIL, username: OWNER_EMAIL });
    if (!old.ok) throw new Error('seed failed');
    await seedHalfCreatedTop(old.value.id);

    const rows = treeRows(0);
    const result = await apply({ orgs: rows.orgs.slice(0, 1), coordinators: [] });
    expect(outcomes(result.rows)).toEqual(['org:Top:resumed']);
    const gone = await idp.findById(old.value.id);
    expect(gone.ok && gone.value).toBeNull();
    const top = await orgByName('Top');
    expect(top?.status).toBe('active');
    expect(top?.ownerKcSub).not.toBe(old.value.id);
  });

  it('resumes a half-created org whose owner also owns a later row, with one owner login', async () => {
    await seedHalfCreatedTop();
    const result = await apply(treeRows(0));
    expect(outcomes(result.rows)).toEqual(['org:Top:resumed', 'org:Child:created']);
    const top = await orgByName('Top');
    const child = await orgByName('Child');
    expect(top?.ownerKcSub).toBeTruthy();
    expect(child?.ownerKcSub).toBe(top?.ownerKcSub);
    const byEmail = await idp.findByEmail(OWNER_EMAIL);
    expect(byEmail.ok && byEmail.value?.id).toBe(top?.ownerKcSub);
  });

  it('gives a later row the login that replaced a removed half-created owner login', async () => {
    const old = await idp.createUser({ email: OWNER_EMAIL, username: OWNER_EMAIL });
    if (!old.ok) throw new Error('seed failed');
    await seedHalfCreatedTop(old.value.id);
    const result = await apply(treeRows(0));
    expect(outcomes(result.rows)).toEqual(['org:Top:resumed', 'org:Child:created']);
    const top = await orgByName('Top');
    const child = await orgByName('Child');
    expect(top?.ownerKcSub).not.toBe(old.value.id);
    expect(child?.ownerKcSub).toBe(top?.ownerKcSub);
  });

  it('fails a half-created org whose owner email has a Keycloak user not linked to it', async () => {
    await idp.createUser({ email: OWNER_EMAIL, username: OWNER_EMAIL });
    const old = await seedHalfCreatedTop();

    const rows = treeRows(0);
    const result = await apply({ orgs: rows.orgs.slice(0, 1), coordinators: [] });
    expect(result.failed).toBe(true);
    expect(outcomes(result.rows)).toEqual(['org:Top:failed']);
    expect(result.rows[0]?.errorCode).toBe('USER_EXISTS');
    // The unlinked user is never adopted or removed.
    const kept = await idp.findByEmail(OWNER_EMAIL);
    expect(kept.ok && kept.value).toBeTruthy();
    expect((await orgStore.findById(old.id)).ok).toBe(true);
  });

  it('recreates a provisioned pending coordinator that has no Keycloak user', async () => {
    const rows = treeRows(1);
    await apply({ orgs: rows.orgs, coordinators: [] });
    const top = await orgByName('Top');
    const seeded = await userStore.create({
      name: 'Top',
      type: 'seeker',
      serves: ['seeker'],
      contact: { name: 'Asha', email: 'asha@alpha.org', phone: '+919876511111' },
      createdBy: PROVISIONED,
      updatedBy: PROVISIONED,
      orgId: top?.id ?? '',
      orgSlug: 'top-asha',
      legacyOrgDetails: null,
      locations: [],
      inviteId: null,
      profile: {},
      profileRef: null,
    });
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.code}`);

    const result = await apply(rows);
    expect(outcomes(result.rows)).toEqual([
      'org:Top:already_loaded',
      'org:Child:already_loaded',
      'coordinator:Asha:resumed',
    ]);
    const asha = await coordinatorByEmail('asha@alpha.org');
    expect(asha?.id).not.toBe(seeded.value.id);
    expect(asha?.status).toBe('active');
    expect(result.rows[2]?.userId).toBe(asha?.id);
  });
});

describe('applyLoadPlan: owner access', () => {
  it('leaves decision_made invited when owner access is only partly granted', async () => {
    idp.failRole = true;
    const rows = treeRows(0);
    const result = await apply({ orgs: rows.orgs.slice(0, 1), coordinators: [] });
    expect(outcomes(result.rows)).toEqual(['org:Top:created']);
    const top = await orgByName('Top');
    expect(top?.status).toBe('active');
    const owner = await kcUser(top?.ownerKcSub ?? '');
    expect(owner.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);

    // A rerun grants the missing role and then marks the owner approved.
    idp.failRole = false;
    const rerun = await apply({ orgs: rows.orgs.slice(0, 1), coordinators: [] });
    expect(outcomes(rerun.rows)).toEqual(['org:Top:already_loaded']);
    const repaired = await kcUser(top?.ownerKcSub ?? '');
    expect(repaired.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['approved']);
    expect(idp.rolesOf(repaired.id)).toContain(OWNER_ROLE);
  });

  it('re-stamps the owner approved on a rerun after the stamp failed', async () => {
    idp.failDecision = true;
    const rows = treeRows(0);
    const first = await apply(rows);
    expect(first.rows.map((r) => r.outcome)).toEqual(['created', 'created']);
    const top = await orgByName('Top');
    const sub = top?.ownerKcSub ?? '';
    expect((await kcUser(sub)).attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);

    idp.failDecision = false;
    const rerun = await apply(rows);
    expect(rerun.rows.map((r) => r.outcome)).toEqual(['already_loaded', 'already_loaded']);
    expect((await kcUser(sub)).attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['approved']);
  });

  it('logs a warning and keeps the row already_loaded when the owner lookup fails', async () => {
    const rows = treeRows(0);
    const only = { orgs: rows.orgs.slice(0, 1), coordinators: [] };
    await apply(only);
    const top = await orgByName('Top');
    if (!top) throw new Error('not loaded');
    const p = await plan(only);
    idp.findById = async () => ({
      ok: false as const,
      error: { code: 'IDP_UNAVAILABLE' as const, message: 'down' },
    });
    const lines: string[] = [];
    const captured = pino(
      { level: 'info' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    ) as unknown as FastifyBaseLogger;
    const rerun = await applyLoadPlan(p, { operator: OPERATOR, log: captured });
    expect(outcomes(rerun.rows)).toEqual(['org:Top:already_loaded']);
    const warn = lines
      .map((l): unknown => JSON.parse(l))
      .find(
        (l) =>
          typeof l === 'object' &&
          l !== null &&
          'operation' in l &&
          l.operation === 'orgLoader.apply.restampInvitedOwner',
      );
    expect(warn).toMatchObject({
      level: 40,
      status: 'failure',
      org_id: top.id,
      code: 'IDP_UNAVAILABLE',
    });
    expect(JSON.stringify(warn)).not.toContain(OWNER_EMAIL);
  });

  it('leaves an owner of a self-registered org alone on the already_loaded path', async () => {
    const rows = treeRows(0);
    await apply({ orgs: rows.orgs.slice(0, 1), coordinators: [] });
    const top = await orgByName('Top');
    if (!top) throw new Error('not loaded');
    const sub = top.ownerKcSub ?? '';
    orgStore.seed([{ ...top, createdBy: 'self' }]);
    await idp.setUserDecision(sub, 'invited');
    await apply({ orgs: rows.orgs.slice(0, 1), coordinators: [] });
    expect((await kcUser(sub)).attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);
  });
});

describe('applyLoadPlan: logs', () => {
  it('logs ids, counts and codes but no names, emails or phones', async () => {
    const lines: string[] = [];
    const captured = pino(
      { level: 'info' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    ) as unknown as FastifyBaseLogger;
    const rows = treeRows();
    idp.failFor = 'bina@alpha.org';
    await applyLoadPlan(await plan(rows), { operator: OPERATOR, log: captured });
    const text = lines.join('\n');
    expect(text).toContain('IDP_UNAVAILABLE');
    for (const pii of [
      'ravi@alpha.org',
      'asha@alpha.org',
      'bina@alpha.org',
      'Ravi',
      'Asha',
      'Bina',
      '98765',
    ]) {
      expect(text).not.toContain(pii);
    }
  });
});
