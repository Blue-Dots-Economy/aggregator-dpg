/**
 * Types and helpers shared by the org and coordinator steps of an org-loader apply, in `@aggregator-dpg/api`.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { TokenRolesOutcome } from '../services/authz/token-roles.js';

/** Error codes apply adds to the shared services' codes. */
export const APPLY_ERROR = {
  /** A planned parent org was not loaded earlier in the run. */
  PARENT_NOT_LOADED: 'PARENT_NOT_LOADED',
  /** A coordinator's planned org was not loaded earlier in the run. */
  ORG_NOT_LOADED: 'ORG_NOT_LOADED',
  /** No Keycloak user is known for an owner shared with an earlier row. */
  OWNER_LOGIN_MISSING: 'OWNER_LOGIN_MISSING',
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  ORG_NOT_PENDING: 'ORG_NOT_PENDING',
  ORG_INACTIVE: 'ORG_INACTIVE',
  COORDINATOR_NOT_FOUND: 'COORDINATOR_NOT_FOUND',
  COORDINATOR_NOT_PENDING: 'COORDINATOR_NOT_PENDING',
  NO_PROFILE_TYPES: 'NO_PROFILE_TYPES',
  /** A row to resume was not created by an operator, so apply leaves it alone. */
  NOT_PROVISIONED: 'NOT_PROVISIONED',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  IDP_UNAVAILABLE: 'IDP_UNAVAILABLE',
  SIGNALSTACK_UNAVAILABLE: 'SIGNALSTACK_UNAVAILABLE',
  /** A step threw; the error type is logged. */
  UNEXPECTED: 'UNEXPECTED',
} as const;

/** What apply did with one row. */
export type RowOutcome = 'created' | 'resumed' | 'already_loaded' | 'failed' | 'not_run';

/** The ids and role-sync outcome of a row that applied. */
export interface RowIds {
  orgId?: string;
  userId?: string;
  signalsOrgId?: string;
  rolesSync?: TokenRolesOutcome;
}

/** The result of applying one row. */
export type RowResult =
  | ({ ok: true; outcome: Exclude<RowOutcome, 'failed' | 'not_run'> } & RowIds)
  | { ok: false; code: string };

/** State carried across the rows of one run. */
export interface ApplyContext {
  /** `provisioned:<operator>`: written as `created_by` and as the approval's `decidedBy`. */
  decidedBy: string;
  log: FastifyBaseLogger;
  /** Org ids loaded in this run or found loaded, by name key. */
  orgIds: Map<string, string>;
  /** Keycloak users created for a `new` owner, by the org row's line. */
  ownerSubs: Map<number, string>;
  /** Owner logins removed with a half-created org, mapped to the login created in their place. */
  replacedSubs: Map<string, string>;
}

/**
 * Fails an outcome no case handled; the compiler checks that none is left.
 *
 * @param _outcome - The unhandled outcome.
 */
export function unhandledOutcome(_outcome: never): RowResult {
  return failed(APPLY_ERROR.UNEXPECTED);
}

/** A failed row result. */
export function failed(code: string): RowResult {
  return { ok: false, code };
}
