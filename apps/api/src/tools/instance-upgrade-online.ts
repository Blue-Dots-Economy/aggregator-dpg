/**
 * The online step of the instance-upgrade tool (`@aggregator-dpg/api`): `enrich`,
 * run in the window after the database commit and before scale-up (design:
 * docs/plans/user-org-migrate-tool-simplification.md §6). It talks to
 * Keycloak through the API's own adapter, so it needs the API's full
 * environment (the Job has it); `train.ts` loads this module lazily so `check`
 * and `run` never depend on it. Counts and ids only in the output.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpAdminAdapter } from '../services/idp-admin/interface.js';
import { IDP_PROVIDER } from '../services/idp-admin/provider.js';
import { getIdentityStore } from '../services/identity-store/index.js';
import type { IdentityStoreBase } from '../services/identity-store/interface.js';
import {
  backfillOwnerContactNames,
  listOwnerNameCandidatesFromDb,
  setContactNameIfMissingInDb,
} from '../services/owner-name-backfill.js';

type Out = (line: string) => void;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Counts of the identity step of `enrich`. */
export interface EnrichReport {
  candidates: number;
  linked: number;
  already: number;
  notInKeycloak: number;
  conflicts: number;
  failed: number;
  /** Coordinator ids with no Keycloak user (they cannot log in today either). */
  absentIds: string[];
  /** Coordinator ids whose login is already recorded differently, or belongs to another account. */
  conflictIds: string[];
}

/** What the identity step of `enrich` needs (fakes in tests). */
export interface EnrichDeps {
  idp: IdpAdminAdapter;
  identities: IdentityStoreBase;
  /** Coordinator ids that have no recorded Keycloak login yet. */
  listCandidates: () => Promise<string[]>;
  /** Pause between Keycloak calls (the pacing). */
  pause?: (ms: number) => Promise<void>;
}

/**
 * Records the Keycloak login of every coordinator that has none yet
 * (`findByAttribute('aggregator_id', id)` → `user_identities`), paced.
 * Idempotent: a re-run picks up only what is still missing.
 *
 * @param deps - Keycloak, the identity store, the candidate list.
 * @param opts - `dryRun` reads only; `ratePerSecond` (> 0) paces Keycloak calls.
 * @returns Per-outcome counts.
 * @throws {RangeError} When `ratePerSecond` is not a positive number.
 */
export async function enrichIdentities(
  deps: EnrichDeps,
  opts: { dryRun: boolean; ratePerSecond: number },
): Promise<EnrichReport> {
  if (!Number.isFinite(opts.ratePerSecond) || opts.ratePerSecond <= 0) {
    throw new RangeError('--rate must be a positive number of calls per second');
  }
  const ids = await deps.listCandidates();
  const report: EnrichReport = {
    candidates: ids.length,
    linked: 0,
    already: 0,
    notInKeycloak: 0,
    conflicts: 0,
    failed: 0,
    absentIds: [],
    conflictIds: [],
  };
  const pause = deps.pause ?? sleep;
  const gapMs = Math.ceil(1000 / opts.ratePerSecond);
  for (const id of ids) {
    // Sequential on purpose: paced against Keycloak.
    const found = await deps.idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, id); // NOSONAR typescript:S9382
    if (!found.ok) report.failed += 1;
    else if (!found.value) {
      report.notInKeycloak += 1;
      report.absentIds.push(id);
    } else if (!opts.dryRun) {
      const linked = await deps.identities.link(id, IDP_PROVIDER, found.value.id, 'coordinator'); // NOSONAR typescript:S9382
      if (!linked.ok) {
        report.conflicts += 1;
        report.conflictIds.push(id);
      } else if (linked.value === 'linked') report.linked += 1;
      else report.already += 1;
    }
    await pause(gapMs); // NOSONAR typescript:S9382
  }
  return report;
}

/** Coordinator ids without a recorded Keycloak login, oldest first. */
async function coordinatorsWithoutLogin(): Promise<string[]> {
  const rows = await getDb().execute<{ id: string }>(sql`
    SELECT u.id::text AS id FROM users u
     WHERE u.user_type = 'coordinator'
       AND NOT EXISTS (SELECT 1 FROM user_identities i
                        WHERE i.user_id = u.id AND i.provider = ${IDP_PROVIDER})
     ORDER BY u.created_at`);
  return rows.rows.map((r) => r.id);
}

/**
 * `enrich`: Keycloak logins, then owner names, with the API's own adapters.
 * Its exit code is the window's identity gate.
 *
 * @param opts - `dryRun` reads only; `ratePerSecond` paces Keycloak calls.
 * @param out - Line printer.
 * @returns Exit code: 1 when any lookup failed or a login conflicts, else 0.
 */
export async function enrich(
  opts: { dryRun: boolean; ratePerSecond: number },
  out: Out,
): Promise<number> {
  const idp = getIdpAdmin();
  const report = await enrichIdentities(
    { idp, identities: getIdentityStore(), listCandidates: coordinatorsWithoutLogin },
    opts,
  );
  const { absentIds, conflictIds, ...counts } = report;
  out(`enrich identities ${JSON.stringify(counts)}${opts.dryRun ? ' (dry run)' : ''}`);
  for (const id of absentIds) out(`  not in keycloak: coordinator ${id}`);
  for (const id of conflictIds) out(`  login conflict: coordinator ${id}`);
  const names = await backfillOwnerContactNames(
    {
      idp,
      listCandidates: listOwnerNameCandidatesFromDb,
      setNameIfMissing: setContactNameIfMissingInDb,
    },
    { dryRun: opts.dryRun },
  );
  out(`enrich owner_names ${JSON.stringify(names)}`);
  return enrichExitCode(report, names);
}

/**
 * The window's identity gate: 0 only when every lookup answered and no login
 * conflicts; coordinators absent from Keycloak do not fail it.
 *
 * @param identities - The identity step's counts.
 * @param names - The owner-name step's counts.
 * @returns 0 or 1.
 */
export function enrichExitCode(
  identities: Pick<EnrichReport, 'failed' | 'conflicts'>,
  names: { failed: number },
): 0 | 1 {
  return identities.failed > 0 || identities.conflicts > 0 || names.failed > 0 ? 1 : 0;
}
