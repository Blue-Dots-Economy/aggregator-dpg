import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import {
  OrganisationStoreFake,
  buildOrganisation,
  buildDefaultOrg,
  _setOrganisationStore,
} from '../../services/organisation-store/index.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../../services/user-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../../services/idp-admin/index.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { _resetOrgSchemaValidator } from '../../services/org-schema-validator.js';
import type { CoordinatorRow, InputProblem, OrgRow } from '../org-loader-input.js';
import { INPUT_PROBLEM } from '../org-loader-input.js';
import { PLAN_PROBLEM, buildLoadPlan, type LoadPlan } from '../org-loader-plan.js';
import { orderParentsFirst, treeLimitRefusals } from '../org-loader-plan-tree.js';

vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'nf-admin@test.local';
});

const ROOT = '00000000-0000-4000-8000-000000000001';
const ROOT_NAME = 'Blue Dots Network';
const PROVISIONED = 'provisioned:ops';

let orgStore: OrganisationStoreFake;
let userStore: UserStoreFake;
let idp: IdpAdminFake;
let nextLine = 2;

function useHierarchy(h: { max_depth: number; max_total_orgs: number; max_children?: number }) {
  const base = buildBlueDotConfig();
  _setNetworkConfig(
    buildBlueDotConfig({
      aggregator: { ...base.aggregator, organisation: { hierarchy: h } },
    }),
  );
}

function orgRow(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    line: nextLine++,
    name: 'Alpha',
    parent: null,
    owner: { name: 'Ravi Kumar', email: 'ravi@alpha.org', phone: '9876500001' },
    extra: {},
    address: {},
    ...overrides,
  };
}

function coordRow(overrides: Partial<CoordinatorRow> = {}): CoordinatorRow {
  return {
    line: nextLine++,
    org: 'Alpha',
    name: 'Asha Kumari',
    email: 'asha@alpha.org',
    phone: '9876511111',
    profileTypes: ['seeker'],
    extra: {},
    ...overrides,
  };
}

function codesAt(plan: LoadPlan, file: InputProblem['file'], line: number): string[] {
  return plan.problems.filter((p) => p.file === file && p.line === line).map((p) => p.code);
}

beforeEach(() => {
  nextLine = 2;
  orgStore = new OrganisationStoreFake();
  orgStore.seedRoot(
    buildOrganisation({
      id: ROOT,
      displayName: ROOT_NAME,
      depth: 0,
      status: 'active',
      ownerEmail: 'nf-admin@test.local',
    }),
  );
  _setOrganisationStore(orgStore);
  userStore = new UserStoreFake();
  _setUserStore(userStore);
  idp = new IdpAdminFake();
  _setIdpAdmin(idp);
  useHierarchy({ max_depth: 5, max_total_orgs: 50 });
});

afterEach(() => {
  delete process.env.DEFAULT_ORG_OWNER_EMAIL;
  _setNetworkConfig(null);
});

describe('buildLoadPlan: ordering and forms', () => {
  it('returns a three-level tree given child-first parent-first, with forms built', async () => {
    const leaf = orgRow({
      name: 'Leaf',
      parent: 'Mid',
      owner: { name: 'Leela', email: 'leela@leaf.org', phone: '9876500003' },
      address: { addressLocality: 'Dharwad' },
      extra: { website: 'https://leaf.org' },
    });
    const mid = orgRow({
      name: 'Mid',
      parent: 'Top',
      owner: { name: 'Mira', email: 'mira@mid.org', phone: '9876500002' },
    });
    const top = orgRow({ name: 'Top' });
    const coord = coordRow({ org: 'leaf', name: 'Asha Kumari' });

    const plan = await buildLoadPlan({ orgs: [leaf, mid, top], coordinators: [coord] });

    expect(plan.problems).toEqual([]);
    expect(plan.orgs.map((o) => o.row.name)).toEqual(['Top', 'Mid', 'Leaf']);
    expect(plan.orgs.map((o) => o.action)).toEqual(['create', 'create', 'create']);
    expect(plan.orgs[0]?.parentRef).toEqual({ kind: 'root' });
    expect(plan.orgs[2]?.parentRef).toEqual({ kind: 'planned', name: 'Mid' });
    expect(plan.orgs[2]?.form).toMatchObject({
      display_name: 'Leaf',
      owner: { name: 'Leela', email: 'leela@leaf.org' },
      address: { addressLocality: 'Dharwad' },
      website: 'https://leaf.org',
    });
    expect(plan.orgs[2]?.phoneE164).toBe('+919876500003');

    expect(plan.coordinators).toHaveLength(1);
    const c = plan.coordinators[0];
    expect(c?.action).toBe('create');
    expect(c?.orgRef).toEqual({ kind: 'planned', name: 'Leaf' });
    expect(c?.body.name).toBe('Leaf');
    expect(c?.body.contact).toMatchObject({ name: 'Asha Kumari', email: 'asha@alpha.org' });
    expect(c?.contact.phone).toBe('+919876511111');
    expect(c?.domains).toEqual(['seeker']);
  });

  it('accepts one owner on two rows with differently written phones', async () => {
    const a = orgRow({ name: 'A' });
    const b = orgRow({
      name: 'B',
      owner: { name: 'Ravi Kumar', email: 'ravi@alpha.org', phone: '+91 98765 00001' },
    });
    const plan = await buildLoadPlan({ orgs: [a, b], coordinators: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.orgs).toHaveLength(2);
  });

  it('links a new owner shared by two rows: first new, later planned', async () => {
    const child = orgRow({ name: 'Child', parent: 'Top' });
    const top = orgRow({ name: 'Top' });
    const plan = await buildLoadPlan({ orgs: [child, top], coordinators: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.orgs.map((o) => [o.row.name, o.ownerRef])).toEqual([
      ['Top', { kind: 'new' }],
      ['Child', { kind: 'planned', line: top.line }],
    ]);
  });

  it('passes input problems through and does not plan those rows', async () => {
    const broken = orgRow({
      name: 'Parent',
      owner: { name: '', email: 'p@x.org', phone: '9876500009' },
    });
    const child = orgRow({ name: 'Child', parent: 'Parent' });
    const grandchild = orgRow({ name: 'Grandchild', parent: 'Child' });
    const other = orgRow({
      name: 'Other',
      owner: { name: 'Olga', email: 'olga@x.org', phone: '9876500010' },
    });
    const coord = coordRow({ org: 'Parent' });
    const inputProblem: InputProblem = {
      file: 'orgs',
      line: broken.line,
      code: INPUT_PROBLEM.REQUIRED,
      field: 'owner_name',
    };
    const plan = await buildLoadPlan({
      orgs: [grandchild, broken, child, other],
      coordinators: [coord],
      inputProblems: [inputProblem],
    });
    expect(plan.problems).toEqual([
      inputProblem,
      { file: 'orgs', line: child.line, code: PLAN_PROBLEM.PARENT_BLOCKED, field: 'parent' },
      { file: 'orgs', line: grandchild.line, code: PLAN_PROBLEM.PARENT_BLOCKED, field: 'parent' },
      { file: 'coordinators', line: coord.line, code: PLAN_PROBLEM.ORG_BLOCKED, field: 'org' },
    ]);
    expect(plan.orgs.map((o) => o.row.name)).toEqual(['Other']);
  });
});

describe('buildLoadPlan: problems in the files', () => {
  it('DUPLICATE_ORG_NAME is case-insensitive', async () => {
    const a = orgRow({ name: 'Alpha' });
    const b = orgRow({
      name: 'alpha ',
      owner: { name: 'Other', email: 'o@o.org', phone: '9876500005' },
    });
    const plan = await buildLoadPlan({ orgs: [a, b], coordinators: [] });
    expect(codesAt(plan, 'orgs', b.line)).toEqual([PLAN_PROBLEM.DUPLICATE_ORG_NAME]);
    expect(codesAt(plan, 'orgs', a.line)).toEqual([]);
  });

  it('OWNER_CONTACT_MISMATCH for one owner email with another phone or name', async () => {
    const a = orgRow({ name: 'A' });
    const b = orgRow({
      name: 'B',
      owner: { name: 'Ravi Kumar', email: 'ravi@alpha.org', phone: '9876500099' },
    });
    const c = orgRow({
      name: 'C',
      owner: { name: 'Someone Else', email: 'ravi@alpha.org', phone: '9876500001' },
    });
    const plan = await buildLoadPlan({ orgs: [a, b, c], coordinators: [] });
    expect(codesAt(plan, 'orgs', b.line)).toEqual([PLAN_PROBLEM.OWNER_CONTACT_MISMATCH]);
    expect(codesAt(plan, 'orgs', c.line)).toEqual([PLAN_PROBLEM.OWNER_CONTACT_MISMATCH]);
  });

  it('OWNER_IS_COORDINATOR when an owner is also a coordinator', async () => {
    const org = orgRow();
    const coord = coordRow({ email: 'ravi@alpha.org', phone: '9876522222' });
    const plan = await buildLoadPlan({ orgs: [org], coordinators: [coord] });
    expect(codesAt(plan, 'coordinators', coord.line)).toEqual([PLAN_PROBLEM.OWNER_IS_COORDINATOR]);
  });

  it('UNKNOWN_COLUMN on line 1 for an orgs header no form field reads', async () => {
    const row = orgRow({ extra: { webiste: 'https://alpha.org' } });
    const plan = await buildLoadPlan({
      orgs: [row],
      coordinators: [],
      orgColumns: [
        'name',
        'parent',
        'owner_name',
        'owner_phone',
        'owner_email',
        'website',
        'state',
        'address_postalCode',
        'webiste',
        'consent',
      ],
    });
    expect(plan.problems).toEqual([
      { file: 'orgs', line: 1, code: PLAN_PROBLEM.UNKNOWN_COLUMN, field: 'webiste' },
      { file: 'orgs', line: 1, code: PLAN_PROBLEM.UNKNOWN_COLUMN, field: 'consent' },
    ]);
  });

  it('UNKNOWN_COLUMN from the rows extra cells when no header is given', async () => {
    const row = orgRow({ extra: { webiste: 'https://alpha.org', state: 'Karnataka' } });
    const plan = await buildLoadPlan({ orgs: [row], coordinators: [] });
    expect(plan.problems).toEqual([
      { file: 'orgs', line: 1, code: PLAN_PROBLEM.UNKNOWN_COLUMN, field: 'webiste' },
    ]);
  });

  it('ORG_DETAILS_READ_ONLY for a coordinator row that sets url', async () => {
    const org = orgRow();
    const coord = coordRow({ extra: { url: 'https://alpha.org' } });
    const plan = await buildLoadPlan({ orgs: [org], coordinators: [coord] });
    expect(plan.problems).toEqual([
      {
        file: 'coordinators',
        line: coord.line,
        code: PLAN_PROBLEM.ORG_DETAILS_READ_ONLY,
        field: 'url',
      },
    ]);
    expect(plan.coordinators).toEqual([]);
  });

  it('DUPLICATE_COORDINATOR on a repeated email or normalised phone', async () => {
    const org = orgRow();
    const a = coordRow();
    const b = coordRow({ email: 'ASHA2@alpha.org', phone: '+91 98765 11111' });
    const c = coordRow({ email: 'asha@alpha.org', phone: '9876533333' });
    const plan = await buildLoadPlan({ orgs: [org], coordinators: [a, b, c] });
    expect(codesAt(plan, 'coordinators', a.line)).toEqual([]);
    expect(codesAt(plan, 'coordinators', b.line)).toEqual([PLAN_PROBLEM.DUPLICATE_COORDINATOR]);
    expect(codesAt(plan, 'coordinators', c.line)).toEqual([PLAN_PROBLEM.DUPLICATE_COORDINATOR]);
  });
});

describe('buildLoadPlan: parents', () => {
  it('UNKNOWN_PARENT when the parent is neither in the file nor an active org', async () => {
    orgStore.seed([
      buildOrganisation({ id: 'p-1', displayName: 'Pending Parent', status: 'pending' }),
    ]);
    const a = orgRow({ name: 'A', parent: 'Nowhere' });
    const b = orgRow({
      name: 'B',
      parent: 'Pending Parent',
      owner: { name: 'Bee', email: 'b@b.org', phone: '9876500006' },
    });
    const plan = await buildLoadPlan({ orgs: [a, b], coordinators: [] });
    expect(codesAt(plan, 'orgs', a.line)).toEqual([PLAN_PROBLEM.UNKNOWN_PARENT]);
    expect(codesAt(plan, 'orgs', b.line)).toEqual([PLAN_PROBLEM.UNKNOWN_PARENT]);
  });

  it('places an org under an existing active org', async () => {
    orgStore.seed([
      buildOrganisation({
        id: 'p-1',
        displayName: 'Existing',
        status: 'active',
        depth: 1,
        parentId: ROOT,
      }),
    ]);
    const plan = await buildLoadPlan({ orgs: [orgRow({ parent: 'existing' })], coordinators: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.orgs[0]?.parentRef).toEqual({ kind: 'existing', orgId: 'p-1' });
  });

  it('PARENT_CYCLE on every row of the cycle, PARENT_BLOCKED below it', async () => {
    const a = orgRow({ name: 'A', parent: 'B' });
    const b = orgRow({
      name: 'B',
      parent: 'A',
      owner: { name: 'Bee', email: 'b@b.org', phone: '9876500006' },
    });
    const c = orgRow({
      name: 'C',
      parent: 'A',
      owner: { name: 'Cee', email: 'c@c.org', phone: '9876500007' },
    });
    const self = orgRow({
      name: 'Self',
      parent: 'self',
      owner: { name: 'Ess', email: 's@s.org', phone: '9876500008' },
    });
    const plan = await buildLoadPlan({ orgs: [a, b, c, self], coordinators: [] });
    expect(codesAt(plan, 'orgs', a.line)).toEqual([PLAN_PROBLEM.PARENT_CYCLE]);
    expect(codesAt(plan, 'orgs', b.line)).toEqual([PLAN_PROBLEM.PARENT_CYCLE]);
    expect(codesAt(plan, 'orgs', self.line)).toEqual([PLAN_PROBLEM.PARENT_CYCLE]);
    expect(codesAt(plan, 'orgs', c.line)).toEqual([PLAN_PROBLEM.PARENT_BLOCKED]);
    expect(plan.orgs).toEqual([]);
  });

  it('COORDINATOR_IN_ROOT when a coordinator names the root', async () => {
    const coord = coordRow({ org: ROOT_NAME.toUpperCase() });
    const plan = await buildLoadPlan({ orgs: [], coordinators: [coord] });
    expect(codesAt(plan, 'coordinators', coord.line)).toEqual([PLAN_PROBLEM.COORDINATOR_IN_ROOT]);
  });

  it('UNKNOWN_ORG when the coordinator org is not in the file nor usable', async () => {
    orgStore.seed([buildDefaultOrg()]);
    const a = coordRow({ org: 'Nowhere' });
    const b = coordRow({ org: 'Default', email: 'b@b.org', phone: '9876544444' });
    const plan = await buildLoadPlan({ orgs: [], coordinators: [a, b] });
    expect(codesAt(plan, 'coordinators', a.line)).toEqual([PLAN_PROBLEM.UNKNOWN_ORG]);
    expect(codesAt(plan, 'coordinators', b.line)).toEqual([PLAN_PROBLEM.UNKNOWN_ORG]);
  });

  it('TREE_LIMIT on depth', async () => {
    useHierarchy({ max_depth: 2, max_total_orgs: 50 });
    const top = orgRow({ name: 'Top' });
    const mid = orgRow({
      name: 'Mid',
      parent: 'Top',
      owner: { name: 'Mira', email: 'mira@mid.org', phone: '9876500002' },
    });
    const leaf = orgRow({
      name: 'Leaf',
      parent: 'Mid',
      owner: { name: 'Leela', email: 'leela@leaf.org', phone: '9876500003' },
    });
    const plan = await buildLoadPlan({ orgs: [top, mid, leaf], coordinators: [] });
    expect(plan.problems).toEqual([
      { file: 'orgs', line: leaf.line, code: PLAN_PROBLEM.TREE_LIMIT, field: 'depth' },
    ]);
  });

  it('TREE_LIMIT on children and total, counting existing orgs', async () => {
    useHierarchy({ max_depth: 5, max_total_orgs: 3, max_children: 2 });
    orgStore.seed([
      buildOrganisation({ id: 'e-1', displayName: 'E1', status: 'active', parentId: ROOT }),
    ]);
    const a = orgRow({ name: 'A' });
    const b = orgRow({ name: 'B' });
    const c = orgRow({ name: 'C', parent: 'A' });
    const d = orgRow({ name: 'D', parent: 'A' });
    const plan = await buildLoadPlan({ orgs: [a, b, c, d], coordinators: [] });
    expect(plan.problems).toEqual([
      { file: 'orgs', line: b.line, code: PLAN_PROBLEM.TREE_LIMIT, field: 'children' },
      { file: 'orgs', line: d.line, code: PLAN_PROBLEM.TREE_LIMIT, field: 'total' },
    ]);
  });
});

describe('buildLoadPlan: against existing data', () => {
  async function seedOwnerOrg(overrides: Parameters<typeof buildOrganisation>[0] = {}) {
    const kc = await idp.createUser({ email: 'ravi@alpha.org', phone: '+919876500001' });
    if (!kc.ok) throw new Error('seed failed');
    const org = buildOrganisation({
      id: 'o-1',
      displayName: 'Owned',
      status: 'active',
      ownerEmail: 'ravi@alpha.org',
      ownerPhone: '+919876500001',
      ownerKcSub: kc.value.id,
      parentId: ROOT,
      ...overrides,
    });
    orgStore.seed([org]);
    return { org, kcSub: kc.value.id };
  }

  it('already_loaded for an active provisioned org with the same owner', async () => {
    await seedOwnerOrg({ displayName: 'Alpha', createdBy: PROVISIONED });
    const plan = await buildLoadPlan({ orgs: [orgRow()], coordinators: [coordRow()] });
    expect(plan.problems).toEqual([]);
    expect(plan.orgs[0]).toMatchObject({ action: 'already_loaded', existingOrgId: 'o-1' });
  });

  it('resume for a pending provisioned org', async () => {
    const { kcSub } = await seedOwnerOrg({
      displayName: 'Alpha',
      status: 'pending',
      createdBy: PROVISIONED,
    });
    const plan = await buildLoadPlan({ orgs: [orgRow()], coordinators: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.orgs[0]).toMatchObject({
      action: 'resume',
      existingOrgId: 'o-1',
      ownerRef: { kind: 'existing', kcSub },
    });
  });

  it('NOT_PROVISIONED_PENDING for a pending self-registered org', async () => {
    await seedOwnerOrg({ displayName: 'Alpha', status: 'pending', createdBy: 'self' });
    const row = orgRow();
    const plan = await buildLoadPlan({ orgs: [row], coordinators: [] });
    expect(codesAt(plan, 'orgs', row.line)).toEqual([PLAN_PROBLEM.NOT_PROVISIONED_PENDING]);
  });

  it('ORG_EXISTS_OTHER_OWNER for an existing name with another owner', async () => {
    orgStore.seed([
      buildOrganisation({ displayName: 'ALPHA', status: 'active', ownerEmail: 'x@x.org' }),
    ]);
    const row = orgRow();
    const plan = await buildLoadPlan({ orgs: [row], coordinators: [] });
    expect(codesAt(plan, 'orgs', row.line)).toEqual([PLAN_PROBLEM.ORG_EXISTS_OTHER_OWNER]);
  });

  it('reuses an existing owner who is the same person', async () => {
    const { kcSub } = await seedOwnerOrg();
    const plan = await buildLoadPlan({ orgs: [orgRow()], coordinators: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.orgs[0]).toMatchObject({
      action: 'create',
      ownerRef: { kind: 'existing', kcSub },
    });
  });

  it('OWNER_LOGIN_MISSING when the existing owner has no Keycloak user', async () => {
    await seedOwnerOrg({ ownerKcSub: 'gone' });
    const row = orgRow();
    const plan = await buildLoadPlan({ orgs: [row], coordinators: [] });
    expect(codesAt(plan, 'orgs', row.line)).toEqual([PLAN_PROBLEM.OWNER_LOGIN_MISSING]);
  });

  it('OWNER_HAS_PENDING_ORG when the owner has an invited org', async () => {
    await seedOwnerOrg();
    orgStore.seed([
      buildOrganisation({
        id: 'o-2',
        displayName: 'Invited',
        status: 'pending',
        ownerEmail: 'ravi@alpha.org',
        ownerPhone: '+919876500001',
      }),
    ]);
    const row = orgRow();
    const plan = await buildLoadPlan({ orgs: [row], coordinators: [] });
    expect(codesAt(plan, 'orgs', row.line)).toEqual([PLAN_PROBLEM.OWNER_HAS_PENDING_ORG]);
  });

  it('OWNER_RESERVED for the network admin and the Default-org owner', async () => {
    process.env.DEFAULT_ORG_OWNER_EMAIL = 'Default-Owner@test.local';
    const a = orgRow({
      name: 'A',
      owner: { name: 'N A', email: 'nf-admin@test.local', phone: '9876500011' },
    });
    const b = orgRow({
      name: 'B',
      owner: { name: 'D O', email: 'default-owner@test.local', phone: '9876500012' },
    });
    const plan = await buildLoadPlan({ orgs: [a, b], coordinators: [] });
    expect(codesAt(plan, 'orgs', a.line)).toEqual([PLAN_PROBLEM.OWNER_RESERVED]);
    expect(codesAt(plan, 'orgs', b.line)).toEqual([PLAN_PROBLEM.OWNER_RESERVED]);
  });

  it('CONTACT_TAKEN when an owner phone or a coordinator email belongs to someone else', async () => {
    userStore.seed([
      buildCoordinator({
        id: 'u-1',
        contact: { name: 'Other', email: 'other@x.org', phone: '+919876500001' },
        status: 'active',
      }),
    ]);
    await idp.createUser({ email: 'kc-only@x.org', phone: '+919876577777' });
    const org = orgRow();
    const coord = coordRow({ email: 'kc-only@x.org', phone: '9876566666' });
    const plan = await buildLoadPlan({ orgs: [org], coordinators: [coord] });
    expect(plan.problems).toEqual([
      { file: 'orgs', line: org.line, code: PLAN_PROBLEM.CONTACT_TAKEN, field: 'owner_phone' },
      { file: 'coordinators', line: coord.line, code: PLAN_PROBLEM.CONTACT_TAKEN, field: 'email' },
    ]);
  });

  it('coordinator already_loaded, resume and NOT_PROVISIONED_PENDING in the same org', async () => {
    const { org } = await seedOwnerOrg({ displayName: 'Alpha', createdBy: PROVISIONED });
    userStore.seed([
      buildCoordinator({
        id: 'u-1',
        contact: { name: 'Asha Kumari', email: 'asha@alpha.org', phone: '+919876511111' },
        status: 'active',
        createdBy: PROVISIONED,
        parentOrgId: org.id,
        isDefaultOrg: false,
      }),
      buildCoordinator({
        id: 'u-2',
        orgSlug: 'u-2',
        contact: { name: 'Bina', email: 'bina@alpha.org', phone: '+919876522222' },
        status: 'pending',
        createdBy: PROVISIONED,
        parentOrgId: org.id,
        isDefaultOrg: false,
      }),
      buildCoordinator({
        id: 'u-3',
        orgSlug: 'u-3',
        contact: { name: 'Chitra', email: 'chitra@alpha.org', phone: '+919876533333' },
        status: 'pending',
        createdBy: 'self',
        parentOrgId: org.id,
        isDefaultOrg: false,
      }),
    ]);
    const a = coordRow();
    const b = coordRow({ name: 'Bina', email: 'bina@alpha.org', phone: '9876522222' });
    const c = coordRow({ name: 'Chitra', email: 'chitra@alpha.org', phone: '9876533333' });
    const plan = await buildLoadPlan({ orgs: [orgRow()], coordinators: [a, b, c] });
    expect(plan.problems).toEqual([
      { file: 'coordinators', line: c.line, code: PLAN_PROBLEM.NOT_PROVISIONED_PENDING },
    ]);
    expect(plan.coordinators.map((p) => [p.action, p.existingUserId])).toEqual([
      ['already_loaded', 'u-1'],
      ['resume', 'u-2'],
    ]);
  });

  it('COORDINATOR_EXISTS_ELSEWHERE for a coordinator of another org', async () => {
    userStore.seed([
      buildCoordinator({
        id: 'u-1',
        contact: { name: 'Asha Kumari', email: 'asha@alpha.org', phone: '+919876511111' },
        status: 'active',
        createdBy: PROVISIONED,
        parentOrgId: 'somewhere-else',
        isDefaultOrg: false,
      }),
    ]);
    const coord = coordRow();
    const plan = await buildLoadPlan({ orgs: [orgRow()], coordinators: [coord] });
    expect(codesAt(plan, 'coordinators', coord.line)).toEqual([
      PLAN_PROBLEM.COORDINATOR_EXISTS_ELSEWHERE,
    ]);
  });

  it('SCHEMA_VALIDATION and INVALID_PHONE with their field', async () => {
    const a = orgRow({ name: 'A', extra: { website: 'not a url' } });
    const b = orgRow({
      name: 'B',
      owner: { name: 'Bee', email: 'b@b.org', phone: '12' },
    });
    const c = coordRow({ org: 'A', profileTypes: ['astronaut'] });
    const d = coordRow({ org: 'A', email: 'd@d.org', phone: 'abc' });
    const plan = await buildLoadPlan({ orgs: [a, b], coordinators: [c, d] });
    expect(plan.problems).toEqual([
      { file: 'orgs', line: a.line, code: PLAN_PROBLEM.SCHEMA_VALIDATION, field: 'website' },
      { file: 'orgs', line: b.line, code: PLAN_PROBLEM.INVALID_PHONE, field: 'owner_phone' },
      {
        file: 'coordinators',
        line: c.line,
        code: PLAN_PROBLEM.SCHEMA_VALIDATION,
        field: 'profile_types',
      },
      { file: 'coordinators', line: d.line, code: PLAN_PROBLEM.INVALID_PHONE, field: 'phone' },
    ]);
  });
});

describe('buildLoadPlan: array-typed org fields (blue_dot/up-gzb schema)', () => {
  const upGzbExtra = { organisation_type: 'educational', management_type: 'private' };

  beforeEach(() => {
    vi.stubEnv('AGGREGATOR_NETWORK', 'blue_dot');
    vi.stubEnv('AGGREGATOR_BRAND', 'up-gzb');
    _resetOrgSchemaValidator();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetOrgSchemaValidator();
  });

  it('splits a required array cell on ";"', async () => {
    const row = orgRow({ extra: { ...upGzbExtra, aggregator_type: ' seeker ; provider;' } });
    const plan = await buildLoadPlan({ orgs: [row], coordinators: [] });
    expect(plan.problems).toEqual([]);
    expect(plan.orgs[0]?.form['aggregator_type']).toEqual(['seeker', 'provider']);
    expect(plan.orgs[0]?.schemaValues['aggregator_type']).toEqual(['seeker', 'provider']);
  });

  it('refuses an empty or missing required array cell', async () => {
    const blank = orgRow({ name: 'A', extra: { ...upGzbExtra, aggregator_type: ' ; ' } });
    const missing = orgRow({ name: 'B', extra: upGzbExtra });
    const plan = await buildLoadPlan({ orgs: [blank, missing], coordinators: [] });
    expect(plan.problems).toEqual([
      {
        file: 'orgs',
        line: blank.line,
        code: PLAN_PROBLEM.SCHEMA_VALIDATION,
        field: 'aggregator_type',
      },
      {
        file: 'orgs',
        line: missing.line,
        code: PLAN_PROBLEM.SCHEMA_VALIDATION,
        field: 'aggregator_type',
      },
    ]);
  });
});

describe('buildLoadPlan: edges and failures', () => {
  it('returns an empty plan for empty files', async () => {
    expect(await buildLoadPlan({ orgs: [], coordinators: [] })).toEqual({
      orgs: [],
      coordinators: [],
      problems: [],
    });
  });

  it('throws when a Keycloak lookup fails', async () => {
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    await expect(buildLoadPlan({ orgs: [orgRow()], coordinators: [] })).rejects.toMatchObject({
      code: 'PLAN_LOOKUP_FAILED',
    });
  });

  it('throws when the root org is missing', async () => {
    orgStore.reset();
    await expect(buildLoadPlan({ orgs: [], coordinators: [] })).rejects.toMatchObject({
      code: 'PLAN_LOOKUP_FAILED',
    });
  });
});

describe('org-loader-plan-tree', () => {
  it('orders parents first and finds cycles', () => {
    const { order, cycle } = orderParentsFirst([
      { key: 'c', parent: { kind: 'planned', key: 'b' }, existing: null },
      { key: 'b', parent: { kind: 'planned', key: 'a' }, existing: null },
      { key: 'a', parent: { kind: 'root' }, existing: null },
      { key: 'x', parent: { kind: 'planned', key: 'y' }, existing: null },
      { key: 'y', parent: { kind: 'planned', key: 'x' }, existing: null },
      { key: 'z', parent: { kind: 'planned', key: 'x' }, existing: null },
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect([...cycle].sort()).toEqual(['x', 'y']);
  });

  it('counts an existing in-file parent by its org id', () => {
    const refused = treeLimitRefusals(
      [
        { key: 'p', parent: { kind: 'root' }, existing: { orgId: 'p-id', depth: 1 } },
        { key: 'c', parent: { kind: 'planned', key: 'p' }, existing: null },
      ],
      { maxDepth: 5, maxChildren: 1, maxTotalOrgs: 10 },
      { rootId: 'r', childCounts: new Map([['p-id', 1]]), total: 2 },
    );
    expect(refused).toEqual(new Map([['c', 'children']]));
  });
});
