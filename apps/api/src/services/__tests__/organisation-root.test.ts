import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { IdpAdminFake } from '../idp-admin/testing.js';
import {
  IdentityMismatchError,
  IdentityTakenError,
  linkIdentity,
} from '../../db/account-writes.js';
import { logger } from '../../logger.js';
import type * as AccountWrites from '../../db/account-writes.js';
import type * as ContactWrites from '../../db/contact-writes.js';
import {
  PLACEHOLDER_OWNER_EMAIL,
  dbRootIdpRecorder,
  ensureRootOrganisation,
  mirrorRootOrganisations,
  provisionRootIdp,
  reconcileRootOrganisations,
  rootConfigFrom,
  type RootConfig,
  type RootIdpRecorder,
  type RootOrgState,
} from '../organisation-root.js';

/** A user row the fake database knows: its contact email and IdP link. */
interface FakeUser {
  email: string;
  subject: string | null;
  isCoordinator: boolean;
}

/** One `organisations` row of the fake database. */
interface FakeOrg {
  id: string;
  type: 'network_facilitator' | 'aggregator';
  slug: string;
  name: string;
  legalName: string | null;
  kcGroupId: string | null;
  owner: string;
}

/** State behind the SQL-matching fake executor. */
interface FakeState {
  hasTable: boolean;
  orgs: FakeOrg[];
  users: Map<string, FakeUser>;
  /** email → contact id. */
  contacts: Map<string, string>;
  /** Slugs held by another live org. */
  takenSlugs: string[];
  /** Users the reconcile asked to release. */
  released: string[];
  sql: string[];
  /** When set, every statement rejects with it. */
  failWith?: unknown;
}

const h = vi.hoisted(() => ({ state: null as FakeState | null }));

vi.mock('../../db/client.js', () => ({ getDb: () => fakeDb(h.state!) }));
vi.mock('../../db/contact-writes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ContactWrites>()),
  linkContact: vi.fn(async (_tx: unknown, input: { email: string }) => {
    const id = `c-${input.email}`;
    h.state!.contacts.set(input.email, id);
    return id;
  }),
}));
vi.mock('../../db/account-writes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountWrites>()),
  linkAdminAccount: vi.fn(async (_tx: unknown, contactId: string) => {
    const id = `admin-${contactId}`;
    const email = [...h.state!.contacts].find(([, c]) => c === contactId)?.[0] ?? '';
    if (!h.state!.users.has(id)) {
      h.state!.users.set(id, { email, subject: null, isCoordinator: false });
    }
    return id;
  }),
  linkIdentity: vi.fn(async () => 'linked'),
}));

const dialect = new PgDialect();

/**
 * A Drizzle stand-in that answers the reconcile's statements from
 * {@link FakeState}, matched on the rendered SQL text.
 */
function fakeDb(state: FakeState) {
  const orgById = (id: unknown) => state.orgs.find((o) => o.id === id);
  const answer = (text: string, params: unknown[]): Array<Record<string, unknown>> => {
    if (/DELETE FROM users/.test(text)) {
      state.released.push(params[0] as string);
      return [];
    }
    if (/to_regclass/.test(text)) return [{ t: state.hasTable ? 'organisations' : null }];
    if (/FROM organisations o\s+JOIN users u/.test(text)) {
      const org = /network_facilitator/.test(text)
        ? state.orgs.find((o) => o.type === 'network_facilitator')
        : state.orgs.find((o) => o.type === 'aggregator' && o.slug === 'default');
      const user = org && state.users.get(org.owner);
      if (!org || !user) return [];
      return [
        {
          id: org.id,
          slug: org.slug,
          name: org.name,
          kc_group_id: org.kcGroupId,
          org_owner: org.owner,
          email: user.email,
          subject: user.subject,
          is_coordinator: user.isCoordinator,
        },
      ];
    }
    if (/SELECT 1 FROM organisations/.test(text)) {
      return state.takenSlugs.includes(params[0] as string) ? [{ one: 1 }] : [];
    }
    const set = /UPDATE organisations SET (\w+)/.exec(text);
    const org = set && orgById(params[1]);
    if (set && org) {
      const v = params[0] as string;
      if (set[1] === 'slug') org.slug = v;
      if (set[1] === 'name') org.name = v;
      if (set[1] === 'legal_name') org.legalName = v;
      if (set[1] === 'org_owner') org.owner = v;
      if (set[1] === 'kc_group_id') org.kcGroupId = v;
      return [];
    }
    if (/SELECT id FROM contact/.test(text)) {
      const id = state.contacts.get(params[0] as string);
      return id ? [{ id }] : [];
    }
    return [];
  };
  const db = {
    execute: (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      state.sql.push(sql);
      if (state.failWith) return Promise.reject(state.failWith);
      return Promise.resolve({ rows: answer(sql, params) });
    },
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  return db;
}

/** A freshly migrated database: both orgs owned by the placeholder account. */
function migratedState(over: Partial<FakeState> = {}): FakeState {
  return {
    hasTable: true,
    orgs: [
      {
        id: 'root-1',
        type: 'network_facilitator',
        slug: 'network',
        name: 'Network',
        legalName: null,
        kcGroupId: null,
        owner: 'u-ph',
      },
      {
        id: 'dflt-1',
        type: 'aggregator',
        slug: 'default',
        name: 'Default',
        legalName: null,
        kcGroupId: null,
        owner: 'u-ph',
      },
    ],
    users: new Map([
      ['u-ph', { email: PLACEHOLDER_OWNER_EMAIL, subject: null, isCoordinator: false }],
    ]),
    contacts: new Map([['ops@example.org', 'c-ops']]),
    takenSlugs: [],
    released: [],
    sql: [],
    ...over,
  };
}

const config = (over: Partial<RootConfig> = {}): RootConfig => ({
  nfSlug: 'blue-dots',
  nfName: 'Blue Dots Foundation',
  nfLegalName: 'Blue Dots Foundation',
  nfOwnerEmail: 'ops@example.org',
  defaultOwnerEmail: null,
  ...over,
});

describe('rootConfigFrom', () => {
  it('takes the legal name over the name, the first admin email, and lowercases emails', () => {
    expect(
      rootConfigFrom(
        { urlSlug: 'blue-dots', name: 'Blue Dots', legalName: 'Blue Dots Foundation' },
        ['Ops@Example.org', 'second@example.org'],
        'Default@Example.org',
      ),
    ).toEqual({
      nfSlug: 'blue-dots',
      nfName: 'Blue Dots Foundation',
      nfLegalName: 'Blue Dots Foundation',
      nfOwnerEmail: 'ops@example.org',
      defaultOwnerEmail: 'default@example.org',
    });
  });

  it('keeps everything when nothing is configured', () => {
    expect(rootConfigFrom(null, [], null)).toEqual({
      nfSlug: null,
      nfName: null,
      nfLegalName: null,
      nfOwnerEmail: null,
      defaultOwnerEmail: null,
    });
  });

  it('falls back to the name when there is no legal name', () => {
    expect(rootConfigFrom({ name: 'Net' }, [], null).nfName).toBe('Net');
  });
});

describe('provisionRootIdp', () => {
  const org = (over: Partial<RootOrgState>): RootOrgState => ({
    id: 'org-1',
    slug: 'network',
    name: 'Network',
    kcGroupId: null,
    ownerUserId: 'u-1',
    ownerEmail: 'ops@example.org',
    ownerSubject: null,
    ownerIsCoordinator: false,
    ...over,
  });

  function recorder(conflict = false) {
    const groups = new Map<string, string>();
    const subjects = new Map<string, string>();
    const r: RootIdpRecorder = {
      async setGroupId(orgId, groupId) {
        groups.set(orgId, groupId);
      },
      async linkSubject(userId, subject) {
        if (conflict) return false;
        subjects.set(userId, subject);
        return true;
      },
    };
    return { r, groups, subjects };
  }

  it('creates a group per org and a disabled user per configured owner', async () => {
    const idp = new IdpAdminFake();
    const { r, groups, subjects } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({}),
        defaultOrg: org({
          id: 'org-2',
          slug: 'default',
          name: 'Default',
          ownerUserId: 'u-2',
          ownerEmail: 'def@example.org',
        }),
      },
      r,
    );
    expect(report).toEqual({
      groupsCreated: 2,
      groupsAdopted: 0,
      usersCreated: 2,
      usersReused: 0,
      ownersRemoved: 0,
      failures: 0,
    });
    expect(idp.getGroup(groups.get('org-1')!)?.name).toBe('org-network-org-1');
    const owner = await idp.findById(subjects.get('u-1')!);
    expect(owner.ok && owner.value?.enabled).toBe(false);
    expect(idp.groupsOf(subjects.get('u-2')!)).toEqual([groups.get('org-2')]);
  });

  it('reuses an existing user untouched and skips work already done', async () => {
    const idp = new IdpAdminFake();
    const existing = await idp.createUser({ email: 'ops@example.org', enabled: true });
    if (!existing.ok) throw new Error('seed');
    const { r } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({}),
        defaultOrg: org({ id: 'org-2', slug: 'default', kcGroupId: 'g-x', ownerSubject: 'sub-x' }),
      },
      r,
    );
    expect(report.usersReused).toBe(1);
    expect(report.usersCreated).toBe(0);
    const still = await idp.findById(existing.value.id);
    expect(still.ok && still.value?.enabled).toBe(true);
  });

  it('never mirrors the placeholder owner', async () => {
    const idp = new IdpAdminFake();
    const { r, subjects } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({ ownerEmail: PLACEHOLDER_OWNER_EMAIL }),
        defaultOrg: org({ id: 'o2', slug: 'default', ownerEmail: PLACEHOLDER_OWNER_EMAIL }),
      },
      r,
    );
    expect(report.usersCreated + report.usersReused).toBe(0);
    expect(subjects.size).toBe(0);
  });

  it('counts failures and carries on (retried next boot)', async () => {
    const idp = new IdpAdminFake();
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    const { r } = recorder(true);
    const report = await provisionRootIdp(
      idp,
      {
        root: org({}),
        defaultOrg: org({ id: 'o2', slug: 'default', kcGroupId: 'g', ownerSubject: 's' }),
      },
      r,
    );
    // The root's group create fails, its owner link conflicts, and adding the
    // Default owner to a group the IdP does not know fails.
    expect(report.failures).toBe(3);
  });

  it("adopts the org's own group after a 409, never another org's", async () => {
    const idp = new IdpAdminFake();
    // An earlier attempt created the root's group but its id was never stored.
    await idp.createGroup('org-network-org-1', { org_id: 'org-1' });
    // A group with the Default org's name already names another org.
    await idp.createGroup('org-default-org-2', { org_id: 'someone-else' });
    const { r, groups } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({ ownerEmail: PLACEHOLDER_OWNER_EMAIL }),
        defaultOrg: org({ id: 'org-2', slug: 'default', ownerEmail: PLACEHOLDER_OWNER_EMAIL }),
      },
      r,
    );
    expect(report.groupsAdopted).toBe(1);
    expect(groups.get('org-1')).toBeDefined();
    expect(groups.has('org-2')).toBe(false);
    expect(report.failures).toBe(1);
  });

  it('removes a replaced owner from the group, keeping its IdP user', async () => {
    const idp = new IdpAdminFake();
    const old = await idp.createUser({ email: 'old@example.org', enabled: true });
    const g = await idp.createGroup('org-network', { org_id: 'org-1' });
    if (!old.ok || !g.ok) throw new Error('seed');
    await idp.addUserToGroup(old.value.id, g.value.id);
    const { r } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({ kcGroupId: g.value.id }),
        defaultOrg: org({ id: 'org-2', slug: 'default', kcGroupId: 'g2', ownerSubject: 's' }),
        replacedOwners: [{ orgId: 'org-1', subject: old.value.id }],
      },
      r,
    );
    expect(report.ownersRemoved).toBe(1);
    expect(idp.groupsOf(old.value.id)).toEqual([]);
    const still = await idp.findById(old.value.id);
    expect(still.ok && still.value).not.toBeNull();
  });

  it("never links a coordinator's IdP user to the admin account", async () => {
    const idp = new IdpAdminFake();
    await idp.createUser({ email: 'ops@example.org', enabled: true });
    const { r, subjects } = recorder();
    const report = await provisionRootIdp(
      idp,
      {
        root: org({ ownerIsCoordinator: true }),
        defaultOrg: org({ id: 'org-2', slug: 'default', ownerIsCoordinator: true }),
      },
      r,
    );
    expect(subjects.size).toBe(0);
    expect(report.usersCreated + report.usersReused).toBe(0);
  });
});

describe('reconcileRootOrganisations', () => {
  beforeEach(() => {
    h.state = migratedState();
  });

  it('puts the configured slug, names and owners in place and releases the placeholder', async () => {
    const state = await reconcileRootOrganisations(
      config({ defaultOwnerEmail: 'def@example.org' }),
    );
    expect(state?.changed).toEqual({ slug: true, name: true, rootOwner: true, defaultOwner: true });
    expect(state?.root).toMatchObject({
      slug: 'blue-dots',
      name: 'Blue Dots Foundation',
      ownerEmail: 'ops@example.org',
      ownerUserId: 'admin-c-ops',
    });
    // The Default owner had no contact yet: a phone-less one is created.
    expect(state?.defaultOrg.ownerEmail).toBe('def@example.org');
    expect(h.state!.orgs[0]!.legalName).toBe('Blue Dots Foundation');
    expect(h.state!.released).toEqual(['u-ph', 'u-ph']);
    // The placeholder never had an IdP user, so there is nothing to remove.
    expect(state?.replacedOwners).toEqual([]);
    expect(h.state!.sql[0]).toMatch(/pg_advisory_xact_lock/);
  });

  it('changes nothing on a second boot with the same config', async () => {
    await reconcileRootOrganisations(config());
    h.state!.sql = [];
    h.state!.released = [];
    const again = await reconcileRootOrganisations(config({ nfLegalName: null }));
    expect(again?.changed).toEqual({
      slug: false,
      name: false,
      rootOwner: false,
      defaultOwner: false,
    });
    expect(h.state!.sql.some((s) => /UPDATE|DELETE/.test(s))).toBe(false);
    // Without DEFAULT_ORG_OWNER_EMAIL the Default org follows the root's owner.
    expect(again?.defaultOrg.ownerUserId).toBe(again?.root.ownerUserId);
  });

  it('keeps the current slug when another live org holds the configured one', async () => {
    h.state = migratedState({ takenSlugs: ['blue-dots'] });
    const warn = vi.spyOn(logger, 'warn');
    const state = await reconcileRootOrganisations(config());
    expect(state?.changed.slug).toBe(false);
    expect(state?.root.slug).toBe('network');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'slug_taken' }),
      expect.any(String),
    );
  });

  it('reports replaced owners that had an IdP subject', async () => {
    h.state = migratedState();
    h.state.users.set('u-old', {
      email: 'old@example.org',
      subject: 's-old',
      isCoordinator: false,
    });
    for (const o of h.state.orgs) o.owner = 'u-old';
    const state = await reconcileRootOrganisations(config());
    expect(state?.replacedOwners).toEqual([
      { orgId: 'root-1', subject: 's-old' },
      { orgId: 'dflt-1', subject: 's-old' },
    ]);
    expect(h.state.released).toEqual(['u-old', 'u-old']);
  });

  it('keeps the owners when no admin email is configured', async () => {
    const state = await reconcileRootOrganisations(config({ nfOwnerEmail: null }));
    expect(state?.changed.rootOwner).toBe(false);
    expect(state?.changed.defaultOwner).toBe(false);
    expect(state?.root.ownerEmail).toBe(PLACEHOLDER_OWNER_EMAIL);
  });

  it('returns null on a database that predates 0028', async () => {
    h.state = migratedState({ hasTable: false });
    await expect(reconcileRootOrganisations(config())).resolves.toBeNull();
  });

  it('returns null when the Default org is missing', async () => {
    h.state = migratedState();
    h.state.orgs = h.state.orgs.filter((o) => o.slug !== 'default');
    await expect(reconcileRootOrganisations(config())).resolves.toBeNull();
  });
});

describe('ensureRootOrganisation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the reconciled state', async () => {
    h.state = migratedState();
    const info = vi.spyOn(logger, 'info');
    const state = await ensureRootOrganisation(config());
    expect(state?.root.slug).toBe('blue-dots');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', slug: true, replaced_owners: 0 }),
    );
  });

  it('skips when there is no root', async () => {
    h.state = migratedState({ hasTable: false });
    await expect(ensureRootOrganisation(config())).resolves.toBeNull();
  });

  it('warns when ADMIN_EMAILS is empty', async () => {
    h.state = migratedState();
    const warn = vi.spyOn(logger, 'warn');
    await ensureRootOrganisation(config({ nfOwnerEmail: null }));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_admin_email' }),
      expect.any(String),
    );
  });

  it('logs only the SQLSTATE on failure and never throws', async () => {
    h.state = migratedState({
      failWith: Object.assign(new Error('select … ops@example.org'), { code: '40P01' }),
    });
    const error = vi.spyOn(logger, 'error');
    await expect(ensureRootOrganisation(config())).resolves.toBeNull();
    const logged = JSON.stringify(error.mock.calls[0]?.[0]);
    expect(logged).toContain('database error 40P01');
    expect(logged).not.toContain('ops@example.org');
  });

  it('logs a generic message for a non-database failure', async () => {
    h.state = migratedState({ failWith: new Error('boom') });
    const error = vi.spyOn(logger, 'error');
    await ensureRootOrganisation(config());
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: 'reconcile failed' }));
  });
});

describe('dbRootIdpRecorder', () => {
  beforeEach(() => {
    h.state = migratedState();
  });

  it('records a group id only when none is recorded', async () => {
    await dbRootIdpRecorder.setGroupId('root-1', 'g-1');
    expect(h.state!.orgs[0]!.kcGroupId).toBe('g-1');
    expect(h.state!.sql.at(-1)).toMatch(/kc_group_id IS NULL/);
  });

  it('links the subject as an admin identity', async () => {
    await expect(dbRootIdpRecorder.linkSubject('u-1', 's-1')).resolves.toBe(true);
    expect(vi.mocked(linkIdentity)).toHaveBeenLastCalledWith(
      expect.anything(),
      'u-1',
      expect.any(String),
      's-1',
      'admin',
    );
  });

  it('reports a conflicting identity as false', async () => {
    vi.mocked(linkIdentity).mockRejectedValueOnce(new IdentityTakenError());
    await expect(dbRootIdpRecorder.linkSubject('u-1', 's-1')).resolves.toBe(false);
    vi.mocked(linkIdentity).mockRejectedValueOnce(new IdentityMismatchError());
    await expect(dbRootIdpRecorder.linkSubject('u-1', 's-1')).resolves.toBe(false);
  });

  it('rethrows any other error', async () => {
    vi.mocked(linkIdentity).mockRejectedValueOnce(new Error('down'));
    await expect(dbRootIdpRecorder.linkSubject('u-1', 's-1')).rejects.toThrow('down');
  });
});

describe('mirrorRootOrganisations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mirrors the reconciled orgs and records their groups', async () => {
    h.state = migratedState();
    const state = await reconcileRootOrganisations(config());
    const info = vi.spyOn(logger, 'info');
    await mirrorRootOrganisations(state!, new IdpAdminFake());
    expect(h.state.orgs.every((o) => o.kcGroupId)).toBe(true);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', groupsCreated: 2, failures: 0 }),
    );
  });

  it('reports a step failure in the summary', async () => {
    h.state = migratedState();
    const state = await reconcileRootOrganisations(config());
    const idp = new IdpAdminFake();
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    const info = vi.spyOn(logger, 'info');
    await mirrorRootOrganisations(state!, idp);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ status: 'failure' }));
  });

  it('never throws when recording fails', async () => {
    h.state = migratedState();
    const state = await reconcileRootOrganisations(config());
    h.state.failWith = Object.assign(new Error('x'), { code: '57P01' });
    const error = vi.spyOn(logger, 'error');
    await expect(mirrorRootOrganisations(state!, new IdpAdminFake())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: 'database error 57P01' }));
  });
});
