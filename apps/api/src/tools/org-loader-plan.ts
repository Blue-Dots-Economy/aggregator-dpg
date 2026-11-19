/**
 * Builds and checks the load plan of the org structure loader, in `@aggregator-dpg/api`.
 *
 * Turns parsed `orgs.csv` / `coordinators.csv` rows into the orgs and
 * coordinators to create, resume or skip, and every problem found in the
 * files, in the tree and against the database and Keycloak. Writes nothing:
 * `check` reports the problems and `apply` refuses to run while any exist.
 */

import { z } from 'zod';
import type { BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { adminEmails, defaultOrgOwnerEmail } from '../config.js';
import { logger } from '../logger.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { treeRules } from '../services/known-as.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import type { Organisation, OrgCursor } from '../services/organisation-store/interface.js';
import { isProvisioned } from '../services/provisioned.js';
import {
  checkCoordinatorForm,
  assertContactFree,
  type CoordinatorForm,
} from '../services/registration/coordinator-create.js';
import {
  checkOrgForm,
  findOwnerContactClash,
  type OrgForm,
} from '../services/registration/org-create.js';
import { getUserStore } from '../services/user-store/index.js';
import type { Coordinator } from '../services/user-store/interface.js';
import type { CoordinatorRow, InputProblem, OrgRow } from './org-loader-input.js';
import {
  orderParentsFirst,
  treeLimitRefusals,
  type TreeNode,
  type TreeParent,
} from './org-loader-plan-tree.js';

/** Problem codes the plan adds to the parser's {@link INPUT_PROBLEM} codes. */
export const PLAN_PROBLEM = {
  DUPLICATE_ORG_NAME: 'DUPLICATE_ORG_NAME',
  OWNER_CONTACT_MISMATCH: 'OWNER_CONTACT_MISMATCH',
  OWNER_IS_COORDINATOR: 'OWNER_IS_COORDINATOR',
  DUPLICATE_COORDINATOR: 'DUPLICATE_COORDINATOR',
  UNKNOWN_PARENT: 'UNKNOWN_PARENT',
  PARENT_CYCLE: 'PARENT_CYCLE',
  COORDINATOR_IN_ROOT: 'COORDINATOR_IN_ROOT',
  UNKNOWN_ORG: 'UNKNOWN_ORG',
  TREE_LIMIT: 'TREE_LIMIT',
  ORG_EXISTS_OTHER_OWNER: 'ORG_EXISTS_OTHER_OWNER',
  OWNER_HAS_PENDING_ORG: 'OWNER_HAS_PENDING_ORG',
  OWNER_RESERVED: 'OWNER_RESERVED',
  /** The existing owner's Keycloak user is gone, so it cannot be reused. */
  OWNER_LOGIN_MISSING: 'OWNER_LOGIN_MISSING',
  CONTACT_TAKEN: 'CONTACT_TAKEN',
  NOT_PROVISIONED_PENDING: 'NOT_PROVISIONED_PENDING',
  COORDINATOR_EXISTS_ELSEWHERE: 'COORDINATOR_EXISTS_ELSEWHERE',
  SCHEMA_VALIDATION: 'SCHEMA_VALIDATION',
  INVALID_PHONE: 'INVALID_PHONE',
  /** A form check threw (for example an unreadable schema). */
  CHECK_FAILED: 'CHECK_FAILED',
} as const;

/** One of the {@link PLAN_PROBLEM} codes. */
export type PlanProblemCode = (typeof PLAN_PROBLEM)[keyof typeof PLAN_PROBLEM];

/** What apply does with a row: create it, approve a pending row it created earlier, or skip it. */
export type PlanAction = 'create' | 'resume' | 'already_loaded';

/** An org to load. */
export interface PlannedOrg {
  row: OrgRow;
  action: PlanAction;
  /** The org's id when it exists (`resume`, `already_loaded`). */
  existingOrgId?: string;
  /** `planned` names another org of the plan, which comes earlier in `orgs`. */
  parentRef:
    { kind: 'root' } | { kind: 'existing'; orgId: string } | { kind: 'planned'; name: string };
  /** The owner's Keycloak user to reuse; absent when apply creates one. */
  existingOwnerKcSub?: string;
  form: OrgForm;
  schemaValues: Record<string, unknown>;
  phoneE164: string;
}

/** A coordinator to load. */
export interface PlannedCoordinator {
  row: CoordinatorRow;
  action: PlanAction;
  /** The coordinator's id when it exists (`resume`, `already_loaded`). */
  existingUserId?: string;
  orgRef: { kind: 'existing'; orgId: string } | { kind: 'planned'; name: string };
  body: CoordinatorForm;
  /** The checked contact, phone in E.164. */
  contact: BecknContact;
  domains: string[];
}

/** The result of {@link buildLoadPlan}. */
export interface LoadPlan {
  /** Plannable orgs, parents first. */
  orgs: PlannedOrg[];
  coordinators: PlannedCoordinator[];
  /** Every problem, the given input problems included, orgs first and by line. */
  problems: InputProblem[];
}

/** Page size of the org name search; the store's maximum. */
const NAME_SEARCH_PAGE = 100;

/** Statuses that hold an org name (the store's unique-name scope). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'active']);

/** Coordinator form paths mapped to their CSV columns. */
const COORDINATOR_FIELD_BY_PATH: Readonly<Record<string, string>> = {
  name: 'org',
  type: 'profile_types',
  'contact.name': 'name',
  'contact.email': 'email',
  'contact.phone': 'phone',
};

const AjvIssuesSchema = z.array(
  z.looseObject({
    instancePath: z.string(),
    params: z.looseObject({ missingProperty: z.string().optional() }).optional(),
  }),
);
const OrgFieldErrorsSchema = z.record(z.string(), z.unknown());

/** Lowercased, trimmed name used to match org names. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A person name compared without case or repeated spaces. */
function personKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The E.164 phone, or `null` when it does not normalise. */
function e164(phone: string): string | null {
  const r = normalisePhone(phone);
  return r.ok ? r.value : null;
}

/** Throws the lookup failure that stops the whole plan. */
function lookupFailed(operation: string, message: string): never {
  throw new UpstreamError(`org-loader plan lookup failed: ${operation}`, {
    code: 'PLAN_LOOKUP_FAILED',
    details: { operation, reason: message },
  });
}

/** Unwraps a store or IdP result, throwing on failure. */
function must<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
  operation: string,
): T {
  if (!result.ok) lookupFailed(operation, result.error.message);
  return result.value;
}

/** Collects problems for one file. */
class Problems {
  readonly list: InputProblem[] = [];
  private readonly blocked = { orgs: new Set<number>(), coordinators: new Set<number>() };

  constructor(input: readonly InputProblem[]) {
    for (const p of input) this.add(p);
  }

  add(p: InputProblem): void {
    this.list.push(p);
    this.blocked[p.file].add(p.line);
  }

  org(line: number, code: PlanProblemCode, field?: string): void {
    this.add({ file: 'orgs', line, code, ...(field ? { field } : {}) });
  }

  coordinator(line: number, code: PlanProblemCode, field?: string): void {
    this.add({ file: 'coordinators', line, code, ...(field ? { field } : {}) });
  }

  isBlocked(file: InputProblem['file'], line: number): boolean {
    return this.blocked[file].has(line);
  }
}

/** Org lookups by name, cached for the run. */
class OrgNames {
  private readonly cache = new Map<string, Organisation | null>();

  /**
   * Finds the live (pending or active) aggregator org with this name, any case.
   *
   * @throws {UpstreamError} When the store fails.
   */
  async find(name: string): Promise<Organisation | null> {
    const key = nameKey(name);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const store = getOrganisationStore();
    let found: Organisation | null = null;
    let cursor: OrgCursor | undefined;
    for (;;) {
      const page = must(
        await store.search({
          orgIds: null,
          namePrefix: name.trim(),
          limit: NAME_SEARCH_PAGE,
          ...(cursor ? { cursor } : {}),
        }),
        'orgStore.search',
      );
      found =
        page.rows.find((o) => nameKey(o.displayName) === key && LIVE_STATUSES.has(o.status)) ??
        null;
      if (found || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.cache.set(key, found);
    return found;
  }
}

/** Per-run context shared by the org and coordinator checks. */
interface PlanContext {
  problems: Problems;
  names: OrgNames;
  root: Organisation;
  /** File orgs by name key: the first row with that name. */
  fileOrgs: Map<string, OrgRow>;
  /** Planned orgs by name key, filled once org checks have run. */
  planned: Map<string, PlannedOrg>;
}

/**
 * Builds the load plan and checks it.
 *
 * Rows with an input problem are used to resolve names and spot duplicates
 * but are never planned. Logs counts and codes only.
 *
 * @param input.inputProblems - The parser's problems; returned in `problems`.
 * @returns The plan; apply must refuse it while `problems` is not empty.
 * @throws {UpstreamError} When a database or Keycloak lookup fails, or the root org is missing.
 * @throws {Error} When the network config cannot be loaded.
 */
export async function buildLoadPlan(input: {
  orgs: OrgRow[];
  coordinators: CoordinatorRow[];
  inputProblems?: InputProblem[];
}): Promise<LoadPlan> {
  const started = Date.now();
  const problems = new Problems(input.inputProblems ?? []);
  const rules = treeRules((await getNetworkConfig()).aggregator.organisation);
  const root = must(await getOrganisationStore().findRoot(), 'orgStore.findRoot');
  if (!root) lookupFailed('orgStore.findRoot', 'no network facilitator root');
  const ctx: PlanContext = {
    problems,
    names: new OrgNames(),
    root,
    fileOrgs: new Map(),
    planned: new Map(),
  };

  checkOrgRowsInFile(input.orgs, ctx);
  checkCoordinatorRowsInFile(input.coordinators, input.orgs, problems);

  const candidates = new Map<string, PlannedOrg>();
  const nodes: TreeNode[] = [];
  for (const row of input.orgs) {
    if (ctx.fileOrgs.get(nameKey(row.name)) !== row) continue;
    const parent = await resolveParent(row, ctx);
    if (!parent) continue;
    const planned = await planOrg(row, parent, ctx, input.orgs);
    nodes.push({
      key: nameKey(row.name),
      parent: parent.tree,
      existing:
        planned?.existingOrgId !== undefined
          ? { orgId: planned.existingOrgId, depth: planned.existingDepth }
          : null,
    });
    if (planned) candidates.set(nameKey(row.name), planned.org);
  }

  const { order, cycle } = orderParentsFirst(nodes);
  for (const key of cycle) {
    const row = ctx.fileOrgs.get(key);
    if (row) problems.org(row.line, PLAN_PROBLEM.PARENT_CYCLE);
  }
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const ordered = order.flatMap((k) => byKey.get(k) ?? []);
  const store = getOrganisationStore();
  const existingParents = [
    root.id,
    ...ordered.flatMap((n) => (n.parent.kind === 'existing' ? [n.parent.orgId] : [])),
    ...ordered.flatMap((n) => (n.existing ? [n.existing.orgId] : [])),
  ];
  const [counts, total] = await Promise.all([
    store.childCounts([...new Set(existingParents)]),
    store.countTotal(),
  ]);
  const refusals = treeLimitRefusals(ordered, rules, {
    rootId: root.id,
    childCounts: new Map(Object.entries(must(counts, 'orgStore.childCounts'))),
    total: must(total, 'orgStore.countTotal'),
  });
  for (const [key, limit] of refusals) {
    const row = ctx.fileOrgs.get(key);
    if (row) problems.org(row.line, PLAN_PROBLEM.TREE_LIMIT, limit);
  }

  const orgs = order.flatMap((key) => {
    const p = candidates.get(key);
    return p && !problems.isBlocked('orgs', p.row.line) ? [p] : [];
  });
  for (const p of orgs) ctx.planned.set(nameKey(p.row.name), p);

  const coordinators: PlannedCoordinator[] = [];
  for (const row of input.coordinators) {
    if (problems.isBlocked('coordinators', row.line)) continue;
    const planned = await planCoordinator(row, ctx);
    if (planned && !problems.isBlocked('coordinators', row.line)) coordinators.push(planned);
  }

  const fileOrder = { orgs: 0, coordinators: 1 };
  problems.list.sort((a, b) => fileOrder[a.file] - fileOrder[b.file] || a.line - b.line);
  const byCode: Record<string, number> = {};
  for (const p of problems.list) byCode[p.code] = (byCode[p.code] ?? 0) + 1;
  logger.info(
    {
      operation: 'orgLoader.buildLoadPlan',
      status: 'success',
      latency_ms: Date.now() - started,
      org_rows: input.orgs.length,
      coordinator_rows: input.coordinators.length,
      planned_orgs: orgs.length,
      planned_coordinators: coordinators.length,
      problem_count: problems.list.length,
      problems_by_code: byCode,
    },
    'org-loader plan built',
  );
  return { orgs, coordinators, problems: problems.list };
}

/**
 * Indexes org names and reports duplicate names and owners whose contact differs between rows.
 */
function checkOrgRowsInFile(rows: readonly OrgRow[], ctx: PlanContext): void {
  const owners = new Map<string, { phone: string; name: string }>();
  const phones = new Map<string, string>();
  for (const row of rows) {
    if (row.name !== '') {
      const key = nameKey(row.name);
      if (ctx.fileOrgs.has(key))
        ctx.problems.org(row.line, PLAN_PROBLEM.DUPLICATE_ORG_NAME, 'name');
      else ctx.fileOrgs.set(key, row);
    }
    const { email } = row.owner;
    if (email === '') continue;
    const phone = e164(row.owner.phone) ?? row.owner.phone;
    const first = owners.get(email);
    if (!first) {
      owners.set(email, { phone, name: personKey(row.owner.name) });
    } else if (first.phone !== phone) {
      ctx.problems.org(row.line, PLAN_PROBLEM.OWNER_CONTACT_MISMATCH, 'owner_phone');
    } else if (first.name !== personKey(row.owner.name)) {
      ctx.problems.org(row.line, PLAN_PROBLEM.OWNER_CONTACT_MISMATCH, 'owner_name');
    }
    const phoneOwner = phones.get(phone);
    if (phoneOwner === undefined) phones.set(phone, email);
    else if (phoneOwner !== email) {
      ctx.problems.org(row.line, PLAN_PROBLEM.OWNER_CONTACT_MISMATCH, 'owner_email');
    }
  }
}

/** Reports coordinators who repeat an email or phone, or who are also an org owner in the file. */
function checkCoordinatorRowsInFile(
  rows: readonly CoordinatorRow[],
  orgs: readonly OrgRow[],
  problems: Problems,
): void {
  const ownerEmails = new Set(orgs.map((o) => o.owner.email).filter((e) => e !== ''));
  const ownerPhones = new Set(orgs.map((o) => e164(o.owner.phone)).filter((p) => p !== null));
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const row of rows) {
    const phone = e164(row.phone) ?? row.phone;
    if (ownerEmails.has(row.email) || ownerPhones.has(phone)) {
      problems.coordinator(row.line, PLAN_PROBLEM.OWNER_IS_COORDINATOR);
    } else if ((row.email !== '' && emails.has(row.email)) || (phone !== '' && phones.has(phone))) {
      problems.coordinator(row.line, PLAN_PROBLEM.DUPLICATE_COORDINATOR);
    }
    if (row.email !== '') emails.add(row.email);
    if (phone !== '') phones.add(phone);
  }
}

/** A resolved parent: the plan's reference and the tree's view of it. */
interface ResolvedParent {
  ref: PlannedOrg['parentRef'];
  tree: TreeParent;
}

/**
 * Resolves an org row's parent: the root, another row of the file, or an active org.
 *
 * @returns The parent, or `null` after reporting UNKNOWN_PARENT.
 */
async function resolveParent(row: OrgRow, ctx: PlanContext): Promise<ResolvedParent | null> {
  if (row.parent === null) return { ref: { kind: 'root' }, tree: { kind: 'root' } };
  const key = nameKey(row.parent);
  const inFile = ctx.fileOrgs.get(key);
  if (inFile) {
    return { ref: { kind: 'planned', name: inFile.name }, tree: { kind: 'planned', key } };
  }
  const existing = await ctx.names.find(row.parent);
  if (existing && existing.status === 'active' && !existing.isDefault) {
    return {
      ref: { kind: 'existing', orgId: existing.id },
      tree: { kind: 'existing', orgId: existing.id, depth: existing.depth },
    };
  }
  ctx.problems.org(row.line, PLAN_PROBLEM.UNKNOWN_PARENT, 'parent');
  return null;
}

/** The org form for a row: its extra fields, then the fixed parts. */
function orgFormOf(row: OrgRow, phoneE164: string): OrgForm {
  return {
    ...row.extra,
    display_name: row.name,
    owner: { name: row.owner.name, email: row.owner.email, phone: phoneE164 },
    ...(Object.keys(row.address).length > 0 ? { address: row.address } : {}),
  };
}

/**
 * Checks one org row against the schema and existing data.
 *
 * @param allRows - Every org row, to tell a pending org being resumed from an invited one.
 * @returns The planned org and the existing org's depth, or `null` when the row has a problem.
 * @throws {UpstreamError} When a lookup fails.
 */
async function planOrg(
  row: OrgRow,
  parent: ResolvedParent,
  ctx: PlanContext,
  allRows: readonly OrgRow[],
): Promise<{ org: PlannedOrg; existingOrgId?: string; existingDepth: number } | null> {
  const { problems } = ctx;
  if (problems.isBlocked('orgs', row.line)) return null;
  const phoneE164 = e164(row.owner.phone);
  if (phoneE164 === null) {
    problems.org(row.line, PLAN_PROBLEM.INVALID_PHONE, 'owner_phone');
    return null;
  }
  const form = orgFormOf(row, phoneE164);
  let schemaValues: Record<string, unknown>;
  try {
    const checked = await checkOrgForm(form);
    if (!checked.ok) {
      if (checked.error.code === 'INVALID_PHONE') {
        problems.org(row.line, PLAN_PROBLEM.INVALID_PHONE, 'owner_phone');
      } else {
        const fieldErrors = OrgFieldErrorsSchema.safeParse(checked.error.fields?.['field_errors']);
        const fields = fieldErrors.success ? Object.keys(fieldErrors.data) : [];
        if (fields.length === 0) problems.org(row.line, PLAN_PROBLEM.SCHEMA_VALIDATION);
        for (const f of fields) problems.org(row.line, PLAN_PROBLEM.SCHEMA_VALIDATION, f);
      }
      return null;
    }
    schemaValues = checked.value.schemaValues;
  } catch (err: unknown) {
    logCheckFailure('orgs', row.line, err);
    problems.org(row.line, PLAN_PROBLEM.CHECK_FAILED);
    return null;
  }

  const email = row.owner.email;
  const reserved = [adminEmails[0]?.toLowerCase(), defaultOrgOwnerEmail()];
  if (reserved.includes(email)) {
    problems.org(row.line, PLAN_PROBLEM.OWNER_RESERVED, 'owner_email');
    return null;
  }
  const base = { row, parentRef: parent.ref, form, schemaValues, phoneE164 };

  const existing = await ctx.names.find(row.name);
  if (existing) {
    if (existing.ownerEmail !== email) {
      problems.org(row.line, PLAN_PROBLEM.ORG_EXISTS_OTHER_OWNER, 'name');
      return null;
    }
    if (existing.status === 'pending' && !isProvisioned(existing.createdBy)) {
      problems.org(row.line, PLAN_PROBLEM.NOT_PROVISIONED_PENDING, 'name');
      return null;
    }
    const action: PlanAction = existing.status === 'pending' ? 'resume' : 'already_loaded';
    return {
      org: {
        ...base,
        action,
        existingOrgId: existing.id,
        ...(existing.ownerKcSub ? { existingOwnerKcSub: existing.ownerKcSub } : {}),
      },
      existingOrgId: existing.id,
      existingDepth: existing.depth,
    };
  }

  const owner = await checkNewOrgOwner(row, phoneE164, ctx, allRows);
  if (!owner.ok) return null;
  return {
    org: {
      ...base,
      action: 'create',
      ...(owner.kcSub ? { existingOwnerKcSub: owner.kcSub } : {}),
    },
    existingDepth: 0,
  };
}

/**
 * Checks the owner of a new org: free contact, or an existing owner who is the same person.
 *
 * @returns `ok` with the Keycloak user to reuse, if any; reports the problem otherwise.
 * @throws {UpstreamError} When a lookup fails.
 */
async function checkNewOrgOwner(
  row: OrgRow,
  phoneE164: string,
  ctx: PlanContext,
  allRows: readonly OrgRow[],
): Promise<{ ok: true; kcSub?: string } | { ok: false }> {
  const { problems } = ctx;
  const email = row.owner.email;
  const orgStore = getOrganisationStore();
  const clash = await findOwnerContactClash(email, phoneE164);
  if (!clash.ok) lookupFailed('findOwnerContactClash', clash.error.code);
  if (clash.value !== null) {
    problems.org(row.line, PLAN_PROBLEM.CONTACT_TAKEN, `owner_${clash.value}`);
    return { ok: false };
  }

  const ownerOrg = must(await orgStore.findByOwnerEmail(email), 'orgStore.findByOwnerEmail');
  if (!ownerOrg) {
    const idp = getIdpAdmin();
    const kcEmail = must(await idp.findByEmail(email), 'idp.findByEmail');
    if (kcEmail) {
      problems.org(row.line, PLAN_PROBLEM.CONTACT_TAKEN, 'owner_email');
      return { ok: false };
    }
    const kcPhone = must(
      await idp.findByAttribute(KC_ATTR.PHONE_NUMBER, phoneE164),
      'idp.findByAttribute.phoneNumber',
    );
    if (kcPhone) {
      problems.org(row.line, PLAN_PROBLEM.CONTACT_TAKEN, 'owner_phone');
      return { ok: false };
    }
    return { ok: true };
  }

  if (ownerOrg.ownerPhone !== phoneE164) {
    problems.org(row.line, PLAN_PROBLEM.CONTACT_TAKEN, 'owner_phone');
    return { ok: false };
  }
  const owned = must(await orgStore.listOwnedBy(ownerOrg.ownerUserId), 'orgStore.listOwnedBy');
  const fileNames = new Set(allRows.map((r) => nameKey(r.name)));
  const invited = owned.some(
    (o) =>
      o.status === 'pending' &&
      !(isProvisioned(o.createdBy) && fileNames.has(nameKey(o.displayName))),
  );
  if (invited) {
    problems.org(row.line, PLAN_PROBLEM.OWNER_HAS_PENDING_ORG, 'owner_email');
    return { ok: false };
  }
  const withLogin =
    owned.find((o) => o.status === 'active' && o.ownerKcSub) ?? owned.find((o) => o.ownerKcSub);
  const kcSub = withLogin?.ownerKcSub;
  const kcUser = kcSub ? must(await getIdpAdmin().findById(kcSub), 'idp.findById') : null;
  if (!kcSub || !kcUser) {
    problems.org(row.line, PLAN_PROBLEM.OWNER_LOGIN_MISSING, 'owner_email');
    return { ok: false };
  }
  return { ok: true, kcSub };
}

/** The coordinator's org: a planned org of the file or an existing active one. */
async function resolveCoordinatorOrg(
  row: CoordinatorRow,
  ctx: PlanContext,
): Promise<{
  ref: PlannedCoordinator['orgRef'];
  displayName: string;
  orgId: string | null;
} | null> {
  const key = nameKey(row.org);
  const inFile = ctx.fileOrgs.get(key);
  if (inFile) {
    return {
      ref: { kind: 'planned', name: inFile.name },
      displayName: inFile.name,
      orgId: ctx.planned.get(key)?.existingOrgId ?? null,
    };
  }
  if (key === nameKey(ctx.root.displayName)) {
    ctx.problems.coordinator(row.line, PLAN_PROBLEM.COORDINATOR_IN_ROOT, 'org');
    return null;
  }
  const existing = await ctx.names.find(row.org);
  if (!existing || existing.status !== 'active' || existing.isDefault) {
    ctx.problems.coordinator(row.line, PLAN_PROBLEM.UNKNOWN_ORG, 'org');
    return null;
  }
  return {
    ref: { kind: 'existing', orgId: existing.id },
    displayName: existing.displayName,
    orgId: existing.id,
  };
}

/** The CSV column a coordinator schema issue points at. */
function coordinatorField(issue: z.infer<typeof AjvIssuesSchema>[number]): string | undefined {
  const path = issue.instancePath.split('/').filter((s) => s !== '');
  if (issue.params?.missingProperty) path.push(issue.params.missingProperty);
  const joined = path.filter((s) => !/^\d+$/.test(s)).join('.');
  return COORDINATOR_FIELD_BY_PATH[joined] ?? (joined === '' ? undefined : joined);
}

/**
 * Checks one coordinator row against the schema and existing data.
 *
 * @returns The planned coordinator, or `null` after reporting its problem.
 * @throws {UpstreamError} When a lookup fails.
 */
async function planCoordinator(
  row: CoordinatorRow,
  ctx: PlanContext,
): Promise<PlannedCoordinator | null> {
  const { problems } = ctx;
  const org = await resolveCoordinatorOrg(row, ctx);
  if (!org) return null;
  const phoneE164 = e164(row.phone);
  if (phoneE164 === null) {
    problems.coordinator(row.line, PLAN_PROBLEM.INVALID_PHONE, 'phone');
    return null;
  }
  const body: CoordinatorForm = {
    ...row.extra,
    name: org.displayName,
    type: row.profileTypes,
    contact: { name: row.name, email: row.email, phone: phoneE164 },
    locations: [],
  };
  let checked: { contact: BecknContact; domains: string[] };
  try {
    const result = await checkCoordinatorForm(body, { consentRequired: false });
    if (!result.ok) {
      if (result.error.code === 'INVALID_PHONE') {
        problems.coordinator(row.line, PLAN_PROBLEM.INVALID_PHONE, 'phone');
        return null;
      }
      const fields = result.error.fields ?? {};
      const issues = AjvIssuesSchema.safeParse(fields['issues']);
      const named = new Set<string | undefined>(
        'type' in fields
          ? ['profile_types']
          : issues.success
            ? issues.data.map((i) => coordinatorField(i))
            : [undefined],
      );
      for (const f of named) problems.coordinator(row.line, PLAN_PROBLEM.SCHEMA_VALIDATION, f);
      return null;
    }
    checked = result.value;
  } catch (err: unknown) {
    logCheckFailure('coordinators', row.line, err);
    problems.coordinator(row.line, PLAN_PROBLEM.CHECK_FAILED);
    return null;
  }

  const base = { row, orgRef: org.ref, body, contact: checked.contact, domains: checked.domains };
  const existing = await checkCoordinatorContact(row, phoneE164, org.orgId, problems);
  if (existing === false) return null;
  if (existing === null) return { ...base, action: 'create' };
  return {
    ...base,
    action: existing.status === 'pending' ? 'resume' : 'already_loaded',
    existingUserId: existing.id,
  };
}

/**
 * Checks a coordinator's email and phone against existing accounts.
 *
 * @param orgId - The target org's id when it exists, else `null`.
 * @returns The coordinator row to resume or skip, `null` when the contact is free, or `false` after reporting a problem.
 * @throws {UpstreamError} When a lookup fails.
 */
async function checkCoordinatorContact(
  row: CoordinatorRow,
  phoneE164: string,
  orgId: string | null,
  problems: Problems,
): Promise<Coordinator | null | false> {
  const orgStore = getOrganisationStore();
  const [ownerByEmail, ownerByPhone] = await Promise.all([
    orgStore.findByOwnerEmail(row.email),
    orgStore.findByOwnerPhone(phoneE164),
  ]);
  const reserved = [adminEmails[0]?.toLowerCase(), defaultOrgOwnerEmail()];
  if (must(ownerByEmail, 'orgStore.findByOwnerEmail') || reserved.includes(row.email)) {
    problems.coordinator(row.line, PLAN_PROBLEM.CONTACT_TAKEN, 'email');
    return false;
  }
  if (must(ownerByPhone, 'orgStore.findByOwnerPhone')) {
    problems.coordinator(row.line, PLAN_PROBLEM.CONTACT_TAKEN, 'phone');
    return false;
  }

  const users = getUserStore();
  const byEmail = must(await users.findByContactEmail(row.email), 'userStore.findByContactEmail');
  if (!byEmail) {
    const free = await assertContactFree(row.email, phoneE164);
    if (free.ok) return null;
    if (free.error.code === 'USER_EXISTS' || free.error.code === 'PHONE_EXISTS') {
      const field = free.error.code === 'USER_EXISTS' ? 'email' : 'phone';
      problems.coordinator(row.line, PLAN_PROBLEM.CONTACT_TAKEN, field);
      return false;
    }
    lookupFailed('assertContactFree', free.error.code);
  }
  if (byEmail.status === 'pending' && !isProvisioned(byEmail.createdBy)) {
    problems.coordinator(row.line, PLAN_PROBLEM.NOT_PROVISIONED_PENDING);
    return false;
  }
  if (orgId === null || byEmail.parentOrgId !== orgId) {
    problems.coordinator(row.line, PLAN_PROBLEM.COORDINATOR_EXISTS_ELSEWHERE, 'org');
    return false;
  }
  const mismatch =
    byEmail.contactPhone !== phoneE164
      ? 'phone'
      : personKey(byEmail.contact.name) !== personKey(row.name)
        ? 'name'
        : !LIVE_STATUSES.has(byEmail.status)
          ? 'email'
          : null;
  if (mismatch) {
    problems.coordinator(row.line, PLAN_PROBLEM.CONTACT_TAKEN, mismatch);
    return false;
  }
  return byEmail;
}

/** Logs a form check that threw: file, line and error type only. */
function logCheckFailure(file: InputProblem['file'], line: number, err: unknown): void {
  logger.error(
    {
      operation: 'orgLoader.buildLoadPlan.check',
      status: 'failure',
      file,
      line,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
    },
    'org-loader form check threw',
  );
}
