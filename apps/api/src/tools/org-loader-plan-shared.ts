/**
 * Problem codes, plan types and lookup helpers shared by the org-loader plan modules, in `@aggregator-dpg/api`.
 */

import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import type { BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { adminEmails, defaultOrgOwnerEmail } from '../config.js';
import { logger } from '../logger.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import type { Organisation, OrgCursor } from '../services/organisation-store/interface.js';
import type { CoordinatorForm } from '../services/registration/coordinator-create.js';
import type { OrgForm } from '../services/registration/org-create.js';
import type { CoordinatorRow, InputProblem, OrgRow } from './org-loader-input.js';

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
export const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'active']);

/** Lowercased, trimmed name used to match org names. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A person name compared without case or repeated spaces. */
export function personKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The E.164 phone, or `null` when it does not normalise. */
export function e164(phone: string): string | null {
  const r = normalisePhone(phone);
  return r.ok ? r.value : null;
}

/**
 * The emails no loaded org may be owned by: the network admin (first `ADMIN_EMAILS`) and the Default-org owner.
 */
export function reservedOwnerEmails(): string[] {
  return [adminEmails[0]?.toLowerCase(), defaultOrgOwnerEmail()].filter(
    (e): e is string => typeof e === 'string' && e !== '',
  );
}

/** Throws the lookup failure that stops the whole plan. */
export function lookupFailed(operation: string, message: string): never {
  throw new UpstreamError(`org-loader plan lookup failed: ${operation}`, {
    code: 'PLAN_LOOKUP_FAILED',
    details: { operation, reason: message },
  });
}

/** Unwraps a store or IdP result, throwing on failure. */
export function must<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
  operation: string,
): T {
  if (!result.ok) lookupFailed(operation, result.error.message);
  return result.value;
}

/** Collects problems for one file. */
export class Problems {
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
export class OrgNames {
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
export interface PlanContext {
  problems: Problems;
  names: OrgNames;
  root: Organisation;
  /** File orgs by name key: the first row with that name. */
  fileOrgs: Map<string, OrgRow>;
  /** Planned orgs by name key, filled once org checks have run. */
  planned: Map<string, PlannedOrg>;
}

/** Logs a form check that threw: file, line and error type only. */
export function logCheckFailure(file: InputProblem['file'], line: number, err: unknown): void {
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
