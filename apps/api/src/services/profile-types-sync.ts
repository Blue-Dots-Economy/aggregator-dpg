/**
 * Sync of coordinators' Keycloak `aggregator_type` from `users.serves`.
 *
 * Belongs to `@aggregator-dpg/api`. The `aggregator_type` token claim decides
 * which domains a coordinator may act on, and `users.serves` is the source of
 * truth for it. This makes each coordinator's Keycloak attribute hold exactly
 * the network domains it serves, and removes the attribute when it serves
 * none. The database and Signals are not changed. Safe to re-run: a second run
 * changes nothing.
 *
 * Runner: `apps/api/scripts/sync-coordinator-profile-types.ts`.
 */

import { and, asc, eq, gt } from 'drizzle-orm';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { users } from '../db/schema.js';
import { getDb } from '../db/client.js';
import { logger } from '../logger.js';
import { KC_ATTR } from './idp-admin/attributes.js';
import type { IdpAdminAdapter, IdpResult } from './idp-admin/interface.js';
import { servedDomains } from './user-store/serves.js';

/** A coordinator's stored profile types. */
export interface CoordinatorServesRow {
  id: string;
  serves: string[];
  status: AggregatorStatus;
}

/** Dependencies of the sync; tests pass fakes. */
export interface ProfileTypesSyncDeps {
  idp: IdpAdminAdapter;
  listCoordinators: () => Promise<CoordinatorServesRow[]>;
  /** The active network's domain ids, in declaration order. */
  domainIds: readonly string[];
  /** Delay before the single retry of a transient Keycloak failure. */
  retryDelayMs?: number;
}

/** Outcome counts and coordinator ids; never names, emails or phones. */
export interface ProfileTypesSyncReport {
  dryRun: boolean;
  coordinators: number;
  /** Keycloak already holds the target types. */
  inStep: number;
  /** Keycloak set to a non-empty list (or would be, on a dry run). */
  set: number;
  /** Keycloak attribute removed (or would be, on a dry run). */
  cleared: number;
  /** Coordinators that serve no network domain, by status. */
  emptyByStatus: Partial<Record<AggregatorStatus, number>>;
  /** Coordinators that serve no network domain. */
  emptyIds: string[];
  /** Coordinators whose stored types are all ids the network does not have. */
  unknownOnlyIds: string[];
  /** Coordinators with no Keycloak user. */
  kcMissingIds: string[];
  /** Coordinators whose Keycloak read or write failed after the retry. */
  failedIds: string[];
}

/** What happened to one coordinator. */
type SyncOutcome = 'inStep' | 'set' | 'cleared' | 'kcMissing' | 'failed';

/** Rows read per database query, so a large table is never read in one go. */
const LIST_BATCH_SIZE = 500;

/** Default delay before retrying a transient Keycloak failure once. */
const DEFAULT_RETRY_DELAY_MS = 500;

/**
 * Makes every coordinator's Keycloak `aggregator_type` match `users.serves`.
 *
 * @param deps - Keycloak adapter, the coordinator list and the network's domain ids.
 * @param opts - `dryRun` reports what would change without writing.
 * @returns Counts and the ids that need attention.
 */
export async function syncCoordinatorProfileTypes(
  deps: ProfileTypesSyncDeps,
  opts: { dryRun: boolean },
): Promise<ProfileTypesSyncReport> {
  const report: ProfileTypesSyncReport = {
    dryRun: opts.dryRun,
    coordinators: 0,
    inStep: 0,
    set: 0,
    cleared: 0,
    emptyByStatus: {},
    emptyIds: [],
    unknownOnlyIds: [],
    kcMissingIds: [],
    failedIds: [],
  };
  const rows = await deps.listCoordinators();
  report.coordinators = rows.length;

  for (const row of rows) {
    const target = servedDomains(row.serves, deps.domainIds);
    if (target.length === 0) {
      report.emptyIds.push(row.id);
      report.emptyByStatus[row.status] = (report.emptyByStatus[row.status] ?? 0) + 1;
      if (row.serves.length > 0) report.unknownOnlyIds.push(row.id);
    }
    // One Keycloak call at a time keeps load on the shared realm low.
    const outcome = await syncOne(deps, row.id, target, opts.dryRun); // NOSONAR typescript:S9382
    if (outcome === 'kcMissing') report.kcMissingIds.push(row.id);
    else if (outcome === 'failed') report.failedIds.push(row.id);
    else report[outcome]++;
  }
  return report;
}

/**
 * Brings one coordinator's Keycloak attribute in line with its target types.
 *
 * @param deps - Collaborators (see {@link ProfileTypesSyncDeps}).
 * @param aggregatorId - The coordinator's `users.id`.
 * @param target - The network domains it serves; empty removes the attribute.
 * @param dryRun - When true, reports what would change without writing.
 * @returns The outcome to count; never throws.
 */
async function syncOne(
  deps: ProfileTypesSyncDeps,
  aggregatorId: string,
  target: string[],
  dryRun: boolean,
): Promise<SyncOutcome> {
  const delayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const start = Date.now();
  const found = await withRetry(
    () => deps.idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, aggregatorId),
    delayMs,
  );
  if (!found.ok) {
    logFailure('profileTypesSync.findUser', aggregatorId, found.error.code, start);
    return 'failed';
  }
  if (!found.value) {
    logger.warn({
      operation: 'profileTypesSync.findUser',
      status: 'skipped',
      reason: 'kc_user_missing',
      aggregator_id: aggregatorId,
    });
    return 'kcMissing';
  }
  const current = found.value.attributes?.[KC_ATTR.AGGREGATOR_TYPE] ?? [];
  if (sameSet(current, target)) return 'inStep';
  const outcome = target.length > 0 ? 'set' : 'cleared';
  if (dryRun) return outcome;

  const kcUserId = found.value.id;
  const written = await withRetry(
    () =>
      deps.idp.setAttributes(kcUserId, {
        [KC_ATTR.AGGREGATOR_TYPE]: target.length > 0 ? target : null,
      }),
    delayMs,
  );
  if (!written.ok) {
    logFailure('profileTypesSync.setAttributes', aggregatorId, written.error.code, start);
    return 'failed';
  }
  logger.info({
    operation: 'profileTypesSync.setAttributes',
    status: 'success',
    outcome,
    latency_ms: Date.now() - start,
    aggregator_id: aggregatorId,
  });
  return outcome;
}

/** Whether two lists hold the same values, ignoring order and repeats. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((v) => right.has(v));
}

/** Logs a failed Keycloak call for one coordinator. */
function logFailure(operation: string, aggregatorId: string, code: string, start: number): void {
  logger.error({
    operation,
    status: 'failure',
    error_type: code,
    latency_ms: Date.now() - start,
    aggregator_id: aggregatorId,
  });
}

/** Runs a Keycloak call, retrying once after `delayMs` when Keycloak is unavailable. */
async function withRetry<T>(
  call: () => Promise<IdpResult<T>>,
  delayMs: number,
): Promise<IdpResult<T>> {
  const first = await call();
  if (first.ok || first.error.code !== 'IDP_UNAVAILABLE') return first;
  await new Promise((r) => setTimeout(r, delayMs));
  return call();
}

/**
 * Lists every coordinator's id, status and stored profile types, whatever its
 * status. Read only.
 *
 * @returns All coordinators, ordered by id.
 */
export async function listCoordinatorServesFromDb(): Promise<CoordinatorServesRow[]> {
  const out: CoordinatorServesRow[] = [];
  let after: string | null = null;
  for (;;) {
    const coordinator = eq(users.userType, 'coordinator');
    const rows: CoordinatorServesRow[] = await getDb()
      .select({ id: users.id, serves: users.serves, status: users.status })
      .from(users)
      .where(after === null ? coordinator : and(coordinator, gt(users.id, after)))
      .orderBy(asc(users.id))
      .limit(LIST_BATCH_SIZE);
    out.push(...rows);
    const last = rows.at(-1);
    if (rows.length < LIST_BATCH_SIZE || !last) return out;
    after = last.id;
  }
}
