/**
 * Standalone data migrations for the instance-upgrade tool (`@aggregator-dpg/api`).
 *
 * The three layers of the upgrade, kept separate on purpose:
 *
 *   1. **Schema** (DDL, and the DML that is *coupled* to it — a constraint
 *      backfill, a column retype that reads the column being dropped, a
 *      seed→re-point→constrain sequence) lives in the drizzle migrations and
 *      is applied by `run` in one transaction.
 *   2. **Standalone data migration** — a data move with **no** ordering
 *      dependency on a DDL step, i.e. it only touches columns that still exist
 *      once the schema is at head — lives here and is applied by
 *      `instance-upgrade data`, after `run`.
 *   3. **External dependencies** (Keycloak) live in the online step
 *      (`enrich` / `enable-owners`).
 *
 * A step is **idempotent** (safe to re-run) and **config-free** (only the
 * database — no app config, no external services). Register new ones in
 * {@link DATA_STEPS}. There are none in this release: every data move in
 * 0027–0029 is schema-coupled and therefore stays in the migration.
 */

import type pg from 'pg';

/** One standalone, idempotent, DB-only data migration. */
export interface DataStep {
  /** Stable id for the log + the runbook. */
  name: string;
  /**
   * Applies the data change on the given client (inside the shared
   * transaction). Must be idempotent.
   */
  apply(client: pg.PoolClient): Promise<void>;
  /**
   * Optional post-apply check: returns the count of rows still wrong. A
   * non-zero result rolls the whole `data` run back.
   */
  verify?(client: pg.PoolClient): Promise<number>;
}

/**
 * The standalone data migrations for this release. Empty: 0027–0029's data
 * moves are all schema-coupled (see the module doc) and live in the migrations.
 */
export const DATA_STEPS: DataStep[] = [];

/** Line printer (matches the tool's `out`). */
type Out = (line: string) => void;

/**
 * Applies every standalone data step in one transaction, verifying each, and
 * commits only when all pass. `--dry-run` always rolls back. An empty registry
 * is a success no-op. Never throws.
 *
 * @param pool - A database pool (config-free; only `DATABASE_URL`).
 * @param steps - The steps to run (defaults to {@link DATA_STEPS}).
 * @param opts - `dryRun` rolls back at the end.
 * @param out - Line printer; counts and step names only, never row data.
 * @returns Exit code: 0 on success / no-op, 1 on a failed step or verify.
 */
export async function runDataSteps(
  pool: pg.Pool,
  steps: DataStep[],
  opts: { dryRun: boolean },
  out: Out,
): Promise<number> {
  if (steps.length === 0) {
    out('data: no standalone data steps in this release');
    return 0;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const step of steps) {
      await step.apply(client);
      const bad = step.verify ? await step.verify(client) : 0;
      const verifyNote = step.verify ? `, verify_bad=${bad}` : '';
      out(`data: ${step.name} applied${verifyNote}`);
      if (bad > 0) {
        await client.query('ROLLBACK');
        out(`data: ${step.name} verify failed (${bad}) — rolled back, nothing applied`);
        return 1;
      }
    }
    if (opts.dryRun) {
      await client.query('ROLLBACK');
      out('data: DRY RUN — all steps applied and verified, then rolled back');
    } else {
      await client.query('COMMIT');
      out(`data: COMMITTED ${steps.length} step(s)`);
    }
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const code = (err as { code?: string }).code;
    const codeNote = code ? ` (${code})` : '';
    out(`data: FAILED — rolled back${codeNote}`);
    return 1;
  } finally {
    client.release();
  }
}
