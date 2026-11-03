/**
 * Integration test for migration 0034 (`org_child_known_as`) against a live
 * Postgres: a database at 0033 holding a nested org tree with config-era
 * `known_as` keys is upgraded, and the result is checked — the new
 * `child_known_as` column and its CHECK, the `known_as` reset, unchanged
 * depth and `updated_at`, and a re-run.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP scratch databases (`orgcka_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
/** 0033 `org_description_profile`: the state before this migration. */
const LAST_BEFORE_IDX = 33;
const TIMEOUT_MS = 120_000;

interface JournalEntry {
  idx: number;
  tag: string;
}

interface OrgRow {
  id: string;
  known_as: string;
  depth: number;
  child_known_as: unknown;
  updated_at: Date;
}

async function one<T extends Record<string, unknown>>(
  db: pg.Pool | pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await db.query(sql, params);
  return r.rows[0] as T;
}

/** Inserts an active aggregator org under `parentId` with a `known_as` key. */
async function seedOrg(
  pool: pg.Pool,
  slug: string,
  parentId: string,
  knownAs: string,
): Promise<string> {
  const r = await one<{ id: string }>(
    pool,
    `INSERT INTO organisations (slug, name, org_type, parent_id, org_owner, status, known_as,
                                updated_at)
     VALUES ($1, $1, 'aggregator', $2,
             (SELECT org_owner FROM organisations WHERE org_type = 'network_facilitator'),
             'active', $3, '2026-01-01T00:00:00Z')
     RETURNING id`,
    [slug, parentId, knownAs],
  );
  return r.id;
}

suite('org child_known_as (migration 0034) — integration', () => {
  let admin: pg.Client;
  let tmpDir: string;
  let pool: pg.Pool;
  let dbName: string;
  const ids = {} as Record<'root' | 'def' | 'a' | 'b' | 'c', string>;
  let before: Map<string, OrgRow>;

  async function rows(): Promise<Map<string, OrgRow>> {
    // `to_jsonb` reads `child_known_as` as null before the column exists.
    const r = await pool.query<OrgRow>(
      `SELECT id, known_as, depth, to_jsonb(o) -> 'child_known_as' AS child_known_as, updated_at
         FROM organisations o`,
    );
    return new Map(r.rows.map((row) => [row.id, row]));
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] } & Record<string, unknown>;
    const older = journal.entries.filter((e) => e.idx <= LAST_BEFORE_IDX);
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'org-child-known-as-'));
    const beforeFolder = path.join(tmpDir, 'migrations');
    await mkdir(path.join(beforeFolder, 'meta'), { recursive: true });
    for (const e of older) {
      await copyFile(
        path.join(MIGRATIONS_DIR, `${e.tag}.sql`),
        path.join(beforeFolder, `${e.tag}.sql`),
      );
    }
    await writeFile(
      path.join(beforeFolder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: older }, null, 2),
    );

    dbName = `orgcka_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({
      connectionString: url.toString(),
      max: 4,
      options: '-c aggregator_dpg.network=blue_dot',
    });
    // Teardown force-drops this scratch DB; swallow the 57P01 it sends an
    // attached backend so it isn't an unhandled error after tests pass.
    pool.on('error', () => undefined);
    await migrate(drizzle(pool), { migrationsFolder: beforeFolder });

    ids.root = (
      await one<{ id: string }>(
        pool,
        `SELECT id FROM organisations WHERE org_type = 'network_facilitator'`,
      )
    ).id;
    ids.def = (
      await one<{ id: string }>(pool, `SELECT id FROM organisations WHERE slug = 'default'`)
    ).id;
    ids.a = await seedOrg(pool, 'org-a', ids.root, 'state');
    ids.b = await seedOrg(pool, 'org-b', ids.a, 'district');
    ids.c = await seedOrg(pool, 'org-c', ids.root, 'aggregator');
    before = await rows();

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dbName) {
      await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('adds child_known_as as a required jsonb column, [] on every row', async () => {
    const col = await one<{ is_nullable: string; data_type: string; column_default: string }>(
      pool,
      `SELECT is_nullable, data_type, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'organisations'
          AND column_name = 'child_known_as'`,
    );
    expect(col).toEqual({
      is_nullable: 'NO',
      data_type: 'jsonb',
      column_default: "'[]'::jsonb",
    });
    for (const row of (await rows()).values()) {
      expect(row.child_known_as).toEqual([]);
    }
  });

  it('accepts an array and refuses any other JSON type', async () => {
    const list = [{ key: 'state', name: 'State', default: true }];
    await pool.query(`UPDATE organisations SET child_known_as = $2::jsonb WHERE id = $1`, [
      ids.root,
      JSON.stringify(list),
    ]);
    expect((await rows()).get(ids.root)?.child_known_as).toEqual(list);
    await pool.query(`UPDATE organisations SET child_known_as = '[]' WHERE id = $1`, [ids.root]);
    for (const bad of ['{}', '"state"', 'null']) {
      await expect(
        pool.query(`UPDATE organisations SET child_known_as = $2::jsonb WHERE id = $1`, [
          ids.a,
          bad,
        ]),
      ).rejects.toThrow(/organisations_child_known_as_chk/);
    }
  });

  it('resets every known_as to aggregator', async () => {
    const r = await pool.query<{ known_as: string }>('SELECT DISTINCT known_as FROM organisations');
    expect(r.rows).toEqual([{ known_as: 'aggregator' }]);
  });

  it('leaves depth and updated_at as they were', async () => {
    const after = await rows();
    expect(after.size).toBe(before.size);
    for (const [id, row] of before) {
      expect(after.get(id)?.depth).toBe(row.depth);
      expect(after.get(id)?.updated_at).toEqual(row.updated_at);
    }
    expect(after.get(ids.b)?.depth).toBe(2);
  });

  it('is a no-op when re-applied', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0034_org_child_known_as.sql'), 'utf8');
    const shape = `SELECT
      (SELECT md5(string_agg(id::text || ':' || depth || ':' || known_as || ':' ||
                             child_known_as::text || ':' || updated_at::text, ',' ORDER BY id))
         FROM organisations) AS rows,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conrelid = 'public.organisations'::regclass
          AND conname = 'organisations_child_known_as_chk') AS checks`;
    const first = await one<{ rows: string; checks: number }>(pool, shape);
    expect(first.checks).toBe(1);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await one(pool, shape)).toEqual(first);
  });
});
