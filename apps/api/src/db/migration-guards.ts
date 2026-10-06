/**
 * Pre-migration guards for `runMigrations()` (`@aggregator-dpg/api`).
 *
 * 1. **Foreign migrations.** A row in `drizzle.__drizzle_migrations` whose
 *    `created_at` is not any journal `when` was applied from a file this
 *    release does not ship — e.g. the abandoned `app_user` 0027/0028 on a dev
 *    database. Drizzle skips by the `when` high-water mark, so continuing
 *    would silently mix two schemas: refuse (tolerated with a warning under
 *    the dev override `ALLOW_TRAIN_ON_BOOT=true`, since dev databases also
 *    carry rows from journal reshuffles). A hash mismatch on a KNOWN `when`
 *    only warns — several shipped migrations were edited after their first
 *    commit, so real instances hold older hashes.
 *
 * 2. **The user & org release train.** Migrations 0023 onwards (up to
 *    {@link TRAIN_LAST_WHEN}) restructure existing data and are applied on an
 *    existing instance by the migration tool, with pods at zero, after its
 *    pre-flight and dry-run (docs/plans/existing-instance-migration.md). At
 *    boot (`RUN_MIGRATIONS_ON_BOOT`) or `pnpm db:migrate`, a pending train
 *    migration on a NON-EMPTY database is refused unless
 *    `ALLOW_TRAIN_ON_BOOT=true` (dev / e2e only). An empty database (fresh
 *    instance, CI) migrates as before, and once the train is applied the
 *    guard never fires again.
 *
 * The tool's `apply` calls `migrateWithLock` directly, so it is not subject to
 * guard 2. Decision logic is pure and unit-tested; the IO is a thin reader.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../logger.js';

/** Journal `when` of the first train migration (0023). */
export const TRAIN_FIRST_WHEN = 1790600000000;
/** Journal `when` of the last train migration shipped so far (0027). */
export const TRAIN_LAST_WHEN = 1791200000000;

/** One journal entry (the fields the guards need). */
export interface JournalEntry {
  when: number;
  tag: string;
}

/** One applied row of `drizzle.__drizzle_migrations`. */
export interface AppliedMigration {
  createdAt: number;
  hash: string;
}

/** Verdict of the foreign-migration check. */
export interface ForeignVerdict {
  /** Applied rows whose `created_at` matches no journal entry. */
  unknown: AppliedMigration[];
  /** Tags whose applied hash differs from the shipped file. */
  hashMismatches: string[];
}

/**
 * Classifies the applied migrations against the shipped journal.
 *
 * @param journal - Shipped entries.
 * @param applied - Rows recorded by drizzle.
 * @param fileHashes - sha256 of each shipped file, keyed by `when`.
 * @returns Unknown rows and hash mismatches.
 */
export function checkForeign(
  journal: JournalEntry[],
  applied: AppliedMigration[],
  fileHashes: Map<number, string>,
): ForeignVerdict {
  const byWhen = new Map(journal.map((e) => [e.when, e]));
  const unknown: AppliedMigration[] = [];
  const hashMismatches: string[] = [];
  for (const row of applied) {
    const entry = byWhen.get(row.createdAt);
    if (!entry) {
      unknown.push(row);
      continue;
    }
    const shipped = fileHashes.get(row.createdAt);
    if (shipped && shipped !== row.hash) hashMismatches.push(entry.tag);
  }
  return { unknown, hashMismatches };
}

/**
 * Whether the train guard refuses this migration run.
 *
 * @param journal - Shipped entries.
 * @param appliedWhens - `created_at` of every applied row.
 * @param nonEmpty - Whether the database holds any registration data.
 * @param allowOverride - `ALLOW_TRAIN_ON_BOOT=true`.
 * @returns The pending train tags when refused, else an empty list.
 */
export function trainRefusal(
  journal: JournalEntry[],
  appliedWhens: number[],
  nonEmpty: boolean,
  allowOverride: boolean,
): string[] {
  if (!nonEmpty || allowOverride) return [];
  const highWater = appliedWhens.length > 0 ? Math.max(...appliedWhens) : -Infinity;
  return journal
    .filter((e) => e.when > highWater && e.when >= TRAIN_FIRST_WHEN && e.when <= TRAIN_LAST_WHEN)
    .map((e) => e.tag);
}

/**
 * Runs both guards against the live database. Throws to stop the migration;
 * logs warnings for hash mismatches and for an override in use.
 *
 * @param pool - Postgres pool.
 * @param migrationsFolder - Folder holding the `.sql` files and `meta/_journal.json`.
 * @param allowTrainOnBoot - Value of `ALLOW_TRAIN_ON_BOOT`.
 * @throws Error when a foreign migration is applied, or the train is pending
 *   on a non-empty database without the override.
 */
export async function runMigrationGuards(
  pool: Pool,
  migrationsFolder: string,
  allowTrainOnBoot: boolean,
): Promise<void> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const entries = journal.entries;

  const metaExists = await pool.query<{ t: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t`,
  );
  if (!metaExists.rows[0]?.t) return; // brand-new database: nothing applied yet

  const appliedRows = await pool.query<{ created_at: string; hash: string }>(
    'SELECT created_at::text AS created_at, hash FROM drizzle.__drizzle_migrations',
  );
  const applied = appliedRows.rows.map((r) => ({ createdAt: Number(r.created_at), hash: r.hash }));

  const fileHashes = new Map<number, string>(
    await Promise.all(
      entries.map(async (e): Promise<[number, string]> => {
        const sql = await readFile(path.join(migrationsFolder, `${e.tag}.sql`), 'utf8');
        return [e.when, createHash('sha256').update(sql).digest('hex')];
      }),
    ),
  );

  const foreign = checkForeign(entries, applied, fileHashes);
  if (foreign.hashMismatches.length > 0) {
    logger.warn(
      { operation: 'migrate.guard', status: 'skipped', tags: foreign.hashMismatches },
      'applied migration differs from the shipped file (edited after release) — continuing',
    );
  }
  // Drizzle skips by the `when` high-water mark, so a foreign row ABOVE a
  // shipped migration that is not recorded makes drizzle skip that migration.
  // Without the override such rows are refused below; with it, the skipped
  // migrations are named in the warning so the skip is never silent.
  const appliedWhens = new Set(applied.map((a) => a.createdAt));
  const unrecorded = entries.filter((e) => !appliedWhens.has(e.when));
  const highestForeign = Math.max(...foreign.unknown.map((u) => u.createdAt), -Infinity);
  const masked = unrecorded.filter((e) => e.when < highestForeign).map((e) => e.tag);
  if (foreign.unknown.length > 0 && allowTrainOnBoot) {
    // Dev / e2e databases accumulate rows from journal reshuffles during
    // development; deployed instances never carry them.
    logger.warn(
      {
        operation: 'migrate.guard',
        status: 'skipped',
        unknown_created_at: foreign.unknown.map((u) => u.createdAt),
        skipped_by_drizzle: masked,
      },
      'applied migrations not in this release — tolerated because ALLOW_TRAIN_ON_BOOT=true (dev / e2e only)',
    );
  } else if (foreign.unknown.length > 0) {
    throw new Error(
      `refusing to migrate: ${foreign.unknown.length} applied migration(s) are not in this release ` +
        `(created_at ${foreign.unknown.map((u) => u.createdAt).join(', ')}). ` +
        'A dev database that ran abandoned migrations must be recreated (or cleaned with the ' +
        "migration tool's `fix drop-app-user`).",
    );
  }

  const nonEmpty = await hasRegistrationData(pool);
  const refused = trainRefusal(
    entries,
    applied.map((a) => a.createdAt),
    nonEmpty,
    allowTrainOnBoot,
  );
  if (refused.length > 0) {
    throw new Error(
      `refusing to apply the user & org release train at boot (${refused.join(', ')}) on a ` +
        'database that holds data. Existing instances apply it with the release-train tool ' +
        '(scripts/user-org-migrate.sh — shipped with the train; until then the train must not be ' +
        'deployed) with pods at zero — see docs/plans/existing-instance-migration.md. ' +
        'Dev / e2e only: ALLOW_TRAIN_ON_BOOT=true.',
    );
  }
  if (allowTrainOnBoot && nonEmpty) {
    logger.warn(
      { operation: 'migrate.guard', status: 'skipped' },
      'ALLOW_TRAIN_ON_BOOT=true — the train guard is bypassed (dev / e2e only)',
    );
  }
}

/**
 * Whether the database holds any registration data: a row in the coordinator
 * table (either name), `aggregator_orgs`, `registration_invites`, or
 * `contact` (when it exists).
 */
async function hasRegistrationData(pool: Pool): Promise<boolean> {
  for (const [table, probe] of DATA_PROBES) {
    const exists = await pool.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [
      `public.${table}`,
    ]);
    if (!exists.rows[0]?.t) continue;
    const any = await pool.query(probe);
    if (any.rowCount && any.rowCount > 0) return true;
  }
  return false;
}

/** Fixed probe per table (no dynamic SQL). */
const DATA_PROBES: ReadonlyArray<readonly [string, string]> = [
  ['users', 'SELECT 1 FROM users LIMIT 1'],
  ['aggregators', 'SELECT 1 FROM aggregators LIMIT 1'],
  ['aggregator_orgs', 'SELECT 1 FROM aggregator_orgs LIMIT 1'],
  ['registration_invites', 'SELECT 1 FROM registration_invites LIMIT 1'],
  ['contact', 'SELECT 1 FROM contact LIMIT 1'],
];
