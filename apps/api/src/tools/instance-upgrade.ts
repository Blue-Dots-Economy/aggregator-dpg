/**
 * Release-train operator entry (`@aggregator-dpg/api`; design:
 * docs/plans/user-org-migrate-tool-simplification.md; runbook:
 * docs/user-org-migration-runbook.md). Shipped in the API image and run as a
 * one-off Job with the API's own ConfigMap and Secret:
 *
 *   node dist/tools/instance-upgrade.js check [--fix <name> [--id <uuid> | --org-id <uuid>] [--dry-run]]
 *   node dist/tools/instance-upgrade.js run (--snapshot-taken <id> | --dry-run)
 *   node dist/tools/instance-upgrade.js enrich [--dry-run] [--rate <n per second>]
 *
 * `check` is read-only (fixes excepted). `run` takes a database from 0022 to
 * the latest shipped migration in ONE transaction that also runs every verify
 * gate and commits only when all pass. `check` and `run` need only
 * `DATABASE_URL` and `AGGREGATOR_NETWORK` (+ `AGGREGATOR_BRAND`); `enrich`
 * needs the full API environment. Output is counts, check ids, error codes and
 * database ids — never row data. Exit codes: 0 ok, 1 refused / failed, 2 usage.
 */

import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { pino } from 'pino';
import {
  applyPending,
  checkForeign,
  MIGRATION_LOCK_SQL_KEY,
  readApplied,
  readJournal,
  shippedFileHashes,
  type Queryable,
} from '../db/migrate-core.js';
import { upgradeLevel, type UpgradeLevel } from './instance-upgrade-logic.js';
import {
  canActAsOwner,
  isFailing,
  otherSessions,
  readInstanceFacts,
  runChecks,
  sqlStatements,
  type CheckRow,
} from './instance-upgrade-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ base: { service: 'train' } });

/** The shipped migrations: `<app>/drizzle/migrations` next to `dist/` / `src/`. */
const MIGRATIONS = path.resolve(__dirname, '../../drizzle/migrations');

/** The verify scripts of every phase in the train, in order (a test ties it to `scripts/sql`). */
export const VERIFY_FILES = ['users-verify.sql', 'organisation-verify.sql', 'cleanup-verify.sql'];

/** Documented fixes: script, and the parameter flag it takes (if any). */
const FIXES: Record<string, { file: string; param?: { flag: string; setting: string } }> = {
  'retire-registration': {
    file: 'retire-registration.sql',
    param: { flag: '--id', setting: 'upgrade_fix.id' },
  },
  'choose-owner-subject': {
    file: 'choose-owner-subject.sql',
    param: { flag: '--org-id', setting: 'upgrade_fix.org_id' },
  },
  'expire-stale-presigns': { file: 'expire-stale-presigns.sql' },
};

/** A refusal: printed as `REFUSED: …`, exit 1. Nothing was changed. */
class Refusal extends Error {}

/** The operator SQL: `TRAIN_SQL_DIR`, else `<app>/sql` in the image, else the checkout's `scripts/sql`. */
function sqlDir(): string {
  if (process.env.TRAIN_SQL_DIR) return process.env.TRAIN_SQL_DIR;
  const inImage = path.resolve(__dirname, '../../sql');
  return existsSync(inImage) ? inImage : path.resolve(__dirname, '../../../../scripts/sql');
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Refusal(`${name} must be set`);
  return v;
}

/**
 * A pool whose every connection carries the 0029 backfill network / brand as
 * session settings, applied inside `connect` so no query runs before them.
 */
function openPool(): pg.Pool {
  const network = env('AGGREGATOR_NETWORK') ?? '';
  const brand = env('AGGREGATOR_BRAND') ?? '';
  class UpgradeClient extends pg.Client {
    override connect(): Promise<pg.Client>;
    override connect(callback: ((err: Error) => void) | ((err: null, c: pg.Client) => void)): void;
    override connect(
      callback?: ((err: Error) => void) | ((err: null, c: pg.Client) => void),
    ): Promise<pg.Client> | void {
      const ready = super.connect().then(async () => {
        await this.query(
          `SELECT set_config('aggregator_dpg.network', $1, false),
                  set_config('aggregator_dpg.brand', $2, false),
                  set_config('TimeZone', 'UTC', false)`,
          [network, brand],
        );
        return this as pg.Client;
      });
      if (!callback) return ready;
      const cb = callback as (err: Error | null, c?: pg.Client) => void;
      ready.then(
        (c) => cb(null, c),
        (err: Error) => cb(err),
      );
    }
  }
  return new pg.Pool({
    connectionString: required('DATABASE_URL'),
    max: 2,
    application_name: 'train',
    // A dropped connection must surface, not hang with the locks held.
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
    Client: UpgradeClient,
  });
}

/** Reads the level and refuses foreign rows (an applied migration not shipped). */
async function levelOf(db: Queryable): Promise<UpgradeLevel> {
  const journal = await readJournal(MIGRATIONS);
  const applied = await readApplied(db);
  const foreign = checkForeign(
    journal,
    applied ?? [],
    await shippedFileHashes(MIGRATIONS, journal),
  );
  if (foreign.unknown.length > 0) {
    throw new Refusal(
      `${foreign.unknown.length} applied migration(s) are not in this release — not an instance at 0022`,
    );
  }
  return upgradeLevel(journal, applied);
}

/** Prints rows and returns the failing ones. */
function report(title: string, rows: CheckRow[]): CheckRow[] {
  out(`== ${title}`);
  for (const r of rows) out(`  ${r.checkId.padEnd(44)} ${r.category.padEnd(8)} ${r.n}`);
  return rows.filter(isFailing);
}

/** Runs every phase's verify gates; returns the failing rows. */
async function verifyGates(db: Queryable): Promise<CheckRow[]> {
  const failing: CheckRow[] = [];
  for (const file of VERIFY_FILES) {
    failing.push(...report(file, await runChecks(db, path.join(sqlDir(), file))));
  }
  return failing;
}

/** Runs a `key | n` counts script. */
async function counts(db: Queryable, file: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const stmt of sqlStatements(await readFile(path.join(sqlDir(), file), 'utf8'))) {
    const r = await db.query<{ key: string; n: string }>(stmt);
    for (const row of r.rows) result.set(row.key, Number(row.n));
  }
  return result;
}

/** Prints the facts the operator must check before anything is written. */
async function banner(pool: pg.Pool, command: string, level: UpgradeLevel): Promise<void> {
  const f = await readInstanceFacts(pool);
  out(`train ${command}`);
  out(
    `  database=${f.database} host=${f.host ?? 'local'} server=${f.systemIdentifier} ` +
      `pg=${f.serverVersion} role=${f.user}`,
  );
  out(`  level=${level.appliedTag ?? 'none'} state=${level.state} pending=${level.pending.length}`);
  const size = await pool.query<{ s: string }>(
    'SELECT pg_size_pretty(pg_database_size(current_database())) AS s',
  );
  out(`  database_size=${size.rows[0]?.s ?? '?'}`);
  out(
    `  config network=${env('AGGREGATOR_NETWORK') ?? '(unset)'} brand=${env('AGGREGATOR_BRAND') ?? '(none)'} ` +
      `admin_emails=${(process.env.ADMIN_EMAILS ?? '').split(',').filter((e) => e.trim()).length}`,
  );
}

/** F19: the Keycloak realm can do what org approval needs. Read-only. */
async function keycloakCheck(): Promise<boolean> {
  const base = env('KEYCLOAK_URL')?.replace(/\/$/, '');
  const realm = env('KEYCLOAK_REALM');
  const clientId = env('KEYCLOAK_ADMIN_CLIENT_ID');
  const secret = env('KEYCLOAK_ADMIN_CLIENT_SECRET');
  if (!base || !realm || !clientId || !secret) {
    out(
      '  F19 keycloak: KEYCLOAK_* not set — check by hand (realm role org_owner; aggregator-api has manage-realm + manage-users)',
    );
    return true;
  }
  try {
    return await keycloakRoles(base, realm, clientId, secret);
  } catch (err) {
    out(`  F19 keycloak: unreachable (${(err as Error).name})`);
    return false;
  }
}

/** The F19 calls; throws when Keycloak cannot be reached after one retry. */
async function keycloakRoles(
  base: string,
  realm: string,
  clientId: string,
  secret: string,
): Promise<boolean> {
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      // One retry for a transient network failure.
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    }
  };
  const tokenRes = await call(`${base}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
    }),
  });
  if (!tokenRes.ok) {
    out(`  F19 keycloak: token request failed (${tokenRes.status})`);
    return false;
  }
  const token = ((await tokenRes.json()) as { access_token?: string }).access_token ?? '';
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as {
    resource_access?: Record<string, { roles?: string[] }>;
  };
  const roles = claims.resource_access?.['realm-management']?.roles ?? [];
  const role = await call(`${base}/admin/realms/${realm}/roles/org_owner`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const ok =
    roles.includes('manage-realm') && roles.includes('manage-users') && role.status === 200;
  out(
    `  F19 keycloak: manage_realm=${roles.includes('manage-realm')} manage_users=${roles.includes('manage-users')} ` +
      `org_owner_role=${role.status === 200}`,
  );
  return ok;
}

/**
 * Whether a `run` (or a boot migration) holds the migration lock right now —
 * e.g. a run still committing after its terminal was lost.
 */
async function migrationInProgress(pool: pg.Pool): Promise<boolean> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ got: boolean }>(
      `SELECT pg_try_advisory_lock(${MIGRATION_LOCK_SQL_KEY}) AS got`,
    );
    if (r.rows[0]?.got) await c.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_SQL_KEY})`);
    return r.rows[0]?.got !== true;
  } finally {
    c.release();
  }
}

/** Other sessions that are not this tool, as `app:count` (empty when none). */
async function foreignSessions(db: Queryable): Promise<string[]> {
  const sessions = await otherSessions(db);
  const tools = sessions.filter((s) => s.tool).reduce((n, s) => n + s.count, 0);
  // Our own pool holds at most one other connection.
  if (tools > 1)
    out(`  other train sessions: ${tools} (another operator, or an orphan of a killed run)`);
  return sessions.filter((s) => !s.tool).map((s) => `${s.applicationName}:${s.count}`);
}

/** Runs a documented fix in one transaction; `--dry-run` rolls it back. */
async function fix(pool: pg.Pool, args: string[]): Promise<number> {
  const name = flag(args, '--fix') ?? '';
  const spec = FIXES[name];
  if (!spec) throw new Refusal(`unknown fix "${name}" (${Object.keys(FIXES).join(', ')})`);
  const value = spec.param ? flag(args, spec.param.flag) : undefined;
  if (spec.param && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? '')) {
    throw new Refusal(`${spec.param.flag} <uuid> is required`);
  }
  const dryRun = args.includes('--dry-run');
  const client = await pool.connect();
  const notices = (n: { message?: string | undefined }) => out(`  ${n.message ?? ''}`);
  client.on('notice', notices);
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    // Never alongside a `run` (or a boot migration) on the same database.
    await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_SQL_KEY})`);
    if ((await levelOf(client)).state !== 'start') {
      throw new Refusal('the level moved: fixes apply to a database at 0022 only');
    }
    if (spec.param)
      await client.query('SELECT set_config($1, $2, true)', [spec.param.setting, value]);
    for (const stmt of sqlStatements(
      await readFile(path.join(sqlDir(), 'fixes', spec.file), 'utf8'),
    )) {
      const r = await client.query(stmt);
      if (r.command === 'UPDATE' || r.command === 'DELETE')
        out(`  ${r.command.toLowerCase()}d ${r.rowCount ?? 0} row(s)`);
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    out(`fix ${name}: ${dryRun ? 'rolled back (dry run)' : 'committed'}`);
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof Refusal) throw err;
    const e = err as { code?: string; message?: string };
    // Our fixes RAISE their own refusals (no row data); anything else: code only.
    out(
      `fix ${name}: FAILED ${e.code === 'P0001' ? (e.message ?? '') : (e.code ?? 'error')} — nothing changed`,
    );
    return 1;
  } finally {
    client.off('notice', notices);
    client.release();
  }
}

async function check(pool: pg.Pool, args: string[]): Promise<number> {
  if (await migrationInProgress(pool)) {
    out(
      'MIGRATION IN PROGRESS — a `run` (or a boot migration) holds the lock; wait, then `check` again',
    );
    return 1;
  }
  const level = await levelOf(pool);
  await banner(pool, 'check', level);
  if (level.state === 'fresh' || level.state === 'other') {
    throw new Refusal(
      `the database is at ${level.appliedTag ?? 'nothing'}: this tool takes 0022 to the end of the train only`,
    );
  }
  if (args.includes('--fix')) {
    if (level.state !== 'start') throw new Refusal('fixes apply to a database at 0022 only');
    return fix(pool, args);
  }
  const foreign = await foreignSessions(pool);
  out(`  other_sessions=${foreign.length === 0 ? 0 : foreign.join(', ')}`);
  out(`  role_can_act_as_owner=${await canActAsOwner(pool)}`);
  if (level.state === 'partial') {
    out(
      `  part-way through the train (a rehearsal database): \`run\` applies the ${level.pending.length} ` +
        'pending migration(s) and every verify gate; the 0022 drain and pre-flight do not apply here',
    );
    out('CHECK PASSED — ready for `run`');
    return 0;
  }
  if (level.state === 'done') {
    // One connection: the verify scripts create TEMP views for later statements.
    const c = await pool.connect();
    const failing = await verifyGates(c).finally(() => c.release());
    const identities = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users u WHERE u.user_type = 'coordinator'
          AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)`,
    );
    out(`  I1 coordinators_without_identity info ${identities.rows[0]?.n ?? '?'}`);
    out(failing.length === 0 ? 'CHECK PASSED (train applied)' : 'CHECK FAILED');
    return failing.length === 0 ? 0 : 1;
  }
  const failing = report(
    'train-check (0022)',
    await runChecks(pool, path.join(sqlDir(), 'instance-upgrade-check.sql')),
  );
  const kcOk = await keycloakCheck();
  const ok = failing.length === 0 && kcOk;
  out(
    ok
      ? 'CHECK PASSED — ready for `run`'
      : `CHECK FAILED — ${failing.length} blocker(s)${kcOk ? '' : ' + keycloak'}`,
  );
  return ok ? 0 : 1;
}

/**
 * Reads the level after a COMMIT that errored. The old transaction holds the
 * migration lock until it commits or aborts, so taking that lock first waits
 * for the real outcome instead of reading a level that is about to change.
 */
async function levelAfterCommit(pool: pg.Pool): Promise<UpgradeLevel | null> {
  try {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '60s'`);
      await c.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_SQL_KEY})`);
      return await levelOf(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  } catch {
    // Unreadable: the caller tells the operator to run `check` first.
    return null;
  }
}

/** Whether the transaction may commit; prints why not. */
async function gatesInside(
  client: pg.PoolClient,
  before: Map<string, number> | null,
): Promise<boolean> {
  const failing = await verifyGates(client);
  for (const f of failing) out(`  FAILING ${f.checkId} = ${f.n}`);
  if (!before) return failing.length === 0;
  const after = await counts(client, 'instance-upgrade-counts-after.sql');
  const differ = [...before.keys()].filter((k) => before.get(k) !== after.get(k));
  out(
    `== completeness: ${differ.length === 0 ? 'every count equal' : `differ: ${differ.join(', ')}`}`,
  );
  return failing.length === 0 && differ.length === 0;
}

async function run(pool: pg.Pool, args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const snapshot = flag(args, '--snapshot-taken')?.trim();
  if (!dryRun && !snapshot)
    throw new Refusal('--snapshot-taken <snapshot id> is required (or --dry-run)');
  required('AGGREGATOR_NETWORK');
  const level = await levelOf(pool);
  await banner(pool, dryRun ? 'run --dry-run' : 'run', level);
  if (level.state === 'done') {
    out('  nothing pending — the train is already applied');
    return 0;
  }
  if (level.state !== 'start' && level.state !== 'partial') {
    throw new Refusal(
      `the database is at ${level.appliedTag ?? 'nothing'}; the train starts from 0022`,
    );
  }
  const sessions = await foreignSessions(pool);
  if (sessions.length > 0) {
    throw new Refusal(
      `other sessions are connected (${sessions.join(', ')}) — scale the API and worker to 0`,
    );
  }
  if (snapshot) out(`  snapshot=${snapshot}`);

  const client = await pool.connect();
  const started = Date.now();
  let committing = false;
  try {
    await client.query('BEGIN');
    // The timeout first, so a stuck boot pod holding the lock fails us fast too.
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_SQL_KEY})`);
    // In the transaction itself, so a pooler cannot lose them; then asserted.
    await client.query(
      `SELECT set_config('aggregator_dpg.network', $1, true),
              set_config('aggregator_dpg.brand', $2, true),
              set_config('TimeZone', 'UTC', true)`,
      [required('AGGREGATOR_NETWORK'), env('AGGREGATOR_BRAND') ?? ''],
    );
    const set = await client.query<{ network: string }>(
      `SELECT current_setting('aggregator_dpg.network', true) AS network`,
    );
    if (set.rows[0]?.network !== required('AGGREGATOR_NETWORK')) {
      throw new Refusal(
        'the session settings did not hold — connect straight to Postgres, not via a pooler',
      );
    }
    // Re-read inside the lock: another runner may have moved the level.
    const inside = await levelOf(client);
    if (inside.state !== level.state || inside.appliedTag !== level.appliedTag)
      throw new Refusal(`the level moved to ${inside.appliedTag ?? 'nothing'}`);
    let before: Map<string, number> | null = null;
    if (inside.state === 'start') {
      const blockers = report(
        'train-check (0022)',
        await runChecks(client, path.join(sqlDir(), 'instance-upgrade-check.sql')),
      );
      if (blockers.length > 0) throw new Refusal(`${blockers.length} blocker(s) — see above`);
      before = await counts(client, 'instance-upgrade-counts-before.sql');
    } else {
      out('  part-way through the train: no 0022 drain / pre-flight / counts; verify gates only');
    }
    out('== applying');
    const tags = new Map((await readJournal(MIGRATIONS)).map((e) => [e.when, e.tag]));
    await applyPending(client, MIGRATIONS, (when, ms) =>
      out(`  applied ${tags.get(when) ?? when} in ${ms} ms`),
    );
    if (!(await gatesInside(client, before))) {
      await client.query('ROLLBACK');
      out(
        'RUN FAILED — a gate is not 0; rolled back: nothing was applied, the database is unchanged',
      );
      return 1;
    }
    if (dryRun) {
      await client.query('ROLLBACK');
      out(`DRY RUN PASSED in ${Date.now() - started} ms — rolled back: nothing was applied`);
      return 0;
    }
    // Last look before the point of no return: anything that connected while
    // the train ran (a self-healing deployment, a restarted worker) would run
    // old code on the new schema.
    const late = await foreignSessions(client);
    if (late.length > 0) {
      await client.query('ROLLBACK');
      out(
        `RUN FAILED — sessions connected during the run (${late.join(', ')}); rolled back: ` +
          'nothing was applied. Stop whatever reconnects (GitOps auto-sync, CronJobs) and run again',
      );
      return 1;
    }
    committing = true;
    const done = await client.query('COMMIT');
    // `pg` reports an aborted transaction's COMMIT as ROLLBACK without throwing.
    if (done.command !== 'COMMIT') throw new Error('COMMIT was turned into a ROLLBACK');
    log.info({
      operation: 'train.run',
      status: 'success',
      snapshot,
      latency_ms: Date.now() - started,
    });
    out(`COMMITTED in ${Date.now() - started} ms — next: enrich, then deploy the new images`);
    return 0;
  } catch (err) {
    if (!committing) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof Refusal) throw err;
    const e = err as { code?: string; constraint?: string; table?: string; message?: string };
    log.error({
      operation: 'train.run',
      status: 'failure',
      code: e.code,
      constraint: e.constraint,
      table: e.table,
      latency_ms: Date.now() - started,
    });
    if (!committing) {
      out(
        `RUN FAILED (${e.code ?? 'error'}${e.code === 'P0001' ? `: ${e.message ?? ''}` : ''}) — ` +
          'rolled back: nothing was applied, the database is unchanged',
      );
      return 1;
    }
    // The COMMIT itself failed: it may have landed before the connection dropped.
    const now = await levelAfterCommit(pool);
    if (now?.state === 'done')
      out('COMMIT reported an error, but the train IS applied — continue with enrich');
    else if (now?.state === 'start')
      out('COMMIT failed — nothing was applied, the database is unchanged');
    else out('COMMIT failed and the level cannot be read — run `check` before scaling anything up');
    return 1;
  } finally {
    client.release();
  }
}

/**
 * Runs one command.
 *
 * @param argv - The command and its flags.
 * @returns The exit code (0 ok, 1 failed, 2 usage).
 * @throws {Refusal} When a guard refuses.
 */
async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'enrich') {
    const pool = openPool();
    try {
      const level = await levelOf(pool);
      if (level.state !== 'done') {
        throw new Refusal(
          `enrich runs after the train (the database is at ${level.appliedTag ?? 'nothing'})`,
        );
      }
    } finally {
      await pool.end();
    }
    const rate = Number(flag(args, '--rate') ?? 5);
    // Loaded lazily: it needs the API's full environment (Keycloak).
    const online = await import('./instance-upgrade-online.js');
    return online.enrich({ dryRun: args.includes('--dry-run'), ratePerSecond: rate }, out);
  }
  if (command !== 'check' && command !== 'run') {
    out(
      'usage: instance-upgrade check [--fix <name> …] | run (--snapshot-taken <id> | --dry-run) | enrich [--dry-run] [--rate n]',
    );
    return 2;
  }
  const pool = openPool();
  try {
    return command === 'check' ? await check(pool, args) : await run(pool, args);
  } finally {
    await pool.end();
  }
}

/** Whether this module is the process entry (also through a symlink). */
function isEntry(): boolean {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url;
  } catch {
    // No such path (e.g. `node -e`): not the entry.
    return false;
  }
}

if (isEntry()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Refusal) {
      out(`REFUSED: ${err.message}`);
    } else {
      const e = err as { code?: string; name?: string };
      log.error({ operation: 'train', status: 'failure', code: e.code, error_type: e.name });
    }
    process.exitCode = 1;
  }
}

/**
 * The CLI, for tests: runs one command and returns its exit code.
 *
 * @throws {Refusal} When a guard refuses (the entry prints `REFUSED: …`).
 */
export { main as _main };
