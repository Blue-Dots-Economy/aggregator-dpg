/**
 * Coordinator checks of the org-loader plan, in `@aggregator-dpg/api`.
 *
 * Checks coordinator rows in the files, resolves each coordinator's org and
 * checks its form and contact against existing accounts.
 */

import { z } from 'zod';
import type { BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { isProvisioned } from '../services/provisioned.js';
import {
  assertContactFree,
  checkCoordinatorForm,
  type CoordinatorForm,
} from '../services/registration/coordinator-create.js';
import { getUserStore } from '../services/user-store/index.js';
import type { Coordinator } from '../services/user-store/interface.js';
import type { CoordinatorRow, OrgRow } from './org-loader-input.js';
import {
  LIVE_STATUSES,
  PLAN_PROBLEM,
  e164,
  logCheckFailure,
  lookupFailed,
  must,
  nameKey,
  personKey,
  reservedOwnerEmails,
  type PlanContext,
  type PlannedCoordinator,
  type Problems,
} from './org-loader-plan-shared.js';

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

/** Reports coordinators who repeat an email or phone, or who are also an org owner in the file. */
export function checkCoordinatorRowsInFile(
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

/** The coordinator's org: a planned org of the file or an existing active one. */
async function resolveCoordinatorOrg(
  row: CoordinatorRow,
  ctx: PlanContext,
): Promise<{
  ref: PlannedCoordinator['orgRef'];
  displayName: string;
  orgId: string | null;
  /** The org's row in the file has a problem. */
  blocked: boolean;
} | null> {
  const key = nameKey(row.org);
  const inFile = ctx.fileOrgs.get(key);
  if (inFile) {
    return {
      blocked: ctx.problems.isBlocked('orgs', inFile.line),
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
    blocked: false,
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
export async function planCoordinator(
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
  if (org.blocked) {
    problems.coordinator(row.line, PLAN_PROBLEM.ORG_BLOCKED, 'org');
    return null;
  }
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
  if (
    must(ownerByEmail, 'orgStore.findByOwnerEmail') ||
    reservedOwnerEmails().includes(row.email)
  ) {
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
