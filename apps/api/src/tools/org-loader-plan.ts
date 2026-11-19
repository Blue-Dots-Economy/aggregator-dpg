/**
 * Builds and checks the load plan of the org structure loader, in `@aggregator-dpg/api`.
 *
 * Turns parsed `orgs.csv` / `coordinators.csv` rows into the orgs and
 * coordinators to create, resume or skip, and every problem found in the
 * files, in the tree and against the database and Keycloak. Writes nothing:
 * `check` reports the problems and `apply` refuses to run while any exist.
 */

import { z } from 'zod';
import { logger } from '../logger.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { treeRules } from '../services/known-as.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { isProvisioned } from '../services/provisioned.js';
import { orgArrayFields, orgSchemaFields } from '../services/org-schema-validator.js';
import {
  checkOrgForm,
  findOwnerContactClash,
  type OrgForm,
} from '../services/registration/org-create.js';
import {
  ADDRESS_PARTS,
  ADDRESS_PREFIX,
  ORG_FIXED_COLUMNS,
  type CoordinatorRow,
  type InputProblem,
  type OrgRow,
} from './org-loader-input.js';
import { checkCoordinatorRowsInFile, planCoordinator } from './org-loader-plan-coordinators.js';
import {
  OrgNames,
  PLAN_PROBLEM,
  Problems,
  e164,
  logCheckFailure,
  lookupFailed,
  must,
  nameKey,
  personKey,
  reservedOwnerEmails,
  type LoadPlan,
  type PlanAction,
  type PlanContext,
  type PlannedCoordinator,
  type PlannedOrg,
} from './org-loader-plan-shared.js';
import {
  orderParentsFirst,
  treeLimitRefusals,
  type TreeNode,
  type TreeParent,
} from './org-loader-plan-tree.js';

export { PLAN_PROBLEM };
export type {
  LoadPlan,
  PlanAction,
  PlannedCoordinator,
  PlannedOrg,
  PlanProblemCode,
} from './org-loader-plan-shared.js';

/** Field errors of a failed org form check, keyed by schema field. */
const OrgFieldErrorsSchema = z.record(z.string(), z.unknown());

/**
 * Builds the load plan and checks it.
 *
 * Rows with an input problem are used to resolve names and spot duplicates
 * but are never planned. Logs counts and codes only.
 *
 * @param input.inputProblems - The parser's problems; returned in `problems`.
 * @param input.orgColumns - The `orgs.csv` header columns; when absent, the rows' extra cells stand in.
 * @returns The plan; apply must refuse it while `problems` is not empty.
 * @throws {UpstreamError} When a database or Keycloak lookup fails, or the root org is missing.
 * @throws {Error} When the network config cannot be loaded.
 */
export async function buildLoadPlan(input: {
  orgs: OrgRow[];
  coordinators: CoordinatorRow[];
  inputProblems?: InputProblem[];
  orgColumns?: readonly string[];
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

  const orgColumns = input.orgColumns ?? [
    ...new Set(input.orgs.flatMap((r) => Object.keys(r.extra))),
  ];
  await checkOrgColumns(orgColumns, problems);
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

  reportBlockedChildren(ctx);

  const orgs = linkNewOwners(
    order.flatMap((key) => {
      const p = candidates.get(key);
      return p && !problems.isBlocked('orgs', p.row.line) ? [p] : [];
    }),
  );
  for (const [key, p] of candidates) ctx.planned.set(key, p);

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

/** `orgs.csv` columns the org form reads besides the fixed, address and schema ones. */
const ORG_FORM_COLUMNS = ['state'] as const;

/**
 * Reports UNKNOWN_COLUMN (line 1) for each `orgs.csv` header the org form does not read.
 *
 * The form check drops keys the schema does not declare, so a misspelt column
 * would otherwise load its values nowhere.
 *
 * @throws {Error} When the org registration schema cannot be found.
 */
async function checkOrgColumns(columns: readonly string[], problems: Problems): Promise<void> {
  if (columns.length === 0) return;
  const known = new Set<string>([
    ...ORG_FIXED_COLUMNS,
    ...ADDRESS_PARTS.map((part) => `${ADDRESS_PREFIX}${part}`),
    ...ORG_FORM_COLUMNS,
    ...(await orgSchemaFields()),
  ]);
  for (const column of columns) {
    if (!known.has(column)) problems.org(1, PLAN_PROBLEM.UNKNOWN_COLUMN, column);
  }
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

/**
 * Reports PARENT_BLOCKED on every org row below a file row that has a problem, at any depth.
 */
function reportBlockedChildren(ctx: PlanContext): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of ctx.fileOrgs.values()) {
      if (row.parent === null || ctx.problems.isBlocked('orgs', row.line)) continue;
      const parent = ctx.fileOrgs.get(nameKey(row.parent));
      if (parent && ctx.problems.isBlocked('orgs', parent.line)) {
        ctx.problems.org(row.line, PLAN_PROBLEM.PARENT_BLOCKED, 'parent');
        changed = true;
      }
    }
  }
}

/**
 * Links rows that share a new owner: the first in apply order keeps `new`, later ones point at its line.
 *
 * @param orgs - The planned orgs, in apply order.
 * @returns The same orgs with `ownerRef` linked.
 */
function linkNewOwners(orgs: PlannedOrg[]): PlannedOrg[] {
  const firstLine = new Map<string, number>();
  return orgs.map((p) => {
    if (p.ownerRef.kind !== 'new') return p;
    const line = firstLine.get(p.row.owner.email);
    if (line === undefined) {
      firstLine.set(p.row.owner.email, p.row.line);
      return p;
    }
    return { ...p, ownerRef: { kind: 'planned', line } };
  });
}

/**
 * Turns the cells of array-typed schema fields into lists: split on `;`, trimmed, empties dropped.
 *
 * @param extra - The row's extra cells.
 * @param arrayFields - The schema's array-typed fields.
 */
function coerceExtras(
  extra: Readonly<Record<string, string>>,
  arrayFields: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(extra).map(([key, value]) => [
      key,
      arrayFields.has(key)
        ? value
            .split(';')
            .map((v) => v.trim())
            .filter((v) => v !== '')
        : value,
    ]),
  );
}

/** The org form for a row: its extra fields (already coerced), then the fixed parts. */
function orgFormOf(row: OrgRow, extra: Record<string, unknown>, phoneE164: string): OrgForm {
  return {
    ...extra,
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
  let form: OrgForm;
  let schemaValues: Record<string, unknown>;
  try {
    form = orgFormOf(row, coerceExtras(row.extra, await orgArrayFields()), phoneE164);
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
  if (reservedOwnerEmails().includes(email)) {
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
        ownerRef: existing.ownerKcSub
          ? { kind: 'existing', kcSub: existing.ownerKcSub }
          : { kind: 'new' },
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
      ownerRef: owner.kcSub ? { kind: 'existing', kcSub: owner.kcSub } : { kind: 'new' },
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
  // Every owned org is a half-created loader org of this file: apply creates the login once.
  const onlyHalfCreated = owned.every(
    (o) =>
      o.status === 'pending' &&
      isProvisioned(o.createdBy) &&
      fileNames.has(nameKey(o.displayName)) &&
      !o.ownerKcSub,
  );
  if (onlyHalfCreated) return { ok: true };
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
