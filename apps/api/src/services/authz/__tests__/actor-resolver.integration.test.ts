/**
 * Integration test for the actor resolver's ancestor walk (`@aggregator-dpg/api`,
 * RBAC R1) against a live Postgres: the recursive query over
 * `organisations.parent_id` for the trees #805 names — five levels, flat,
 * siblings, a removed parent — and a cycle, which must stay bounded.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP a scratch database (`rbac_<random>`), so its role needs CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { _setDbClients } from '../../../db/client.js';
import { PostgresActorResolver } from '../actor-resolver/postgres.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite('PostgresActorResolver.orgChain (live Postgres)', () => {
  const dbName = `rbac_${randomBytes(6).toString('hex')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  const nf = randomUUID();
  const l1 = randomUUID();
  const l2 = randomUUID();
  const l3 = randomUUID();
  const l4 = randomUUID();
  const l5 = randomUUID();
  const s1 = randomUUID();
  const s2 = randomUUID();
  const orphan = randomUUID();
  const c1 = randomUUID();
  const c2 = randomUUID();

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    // Only the columns the query reads; no FK, so a removed parent and a cycle
    // can be represented as they would look after a data fault.
    await pool.query('CREATE TABLE organisations (id uuid PRIMARY KEY, parent_id uuid)');
    const rows: Array<[string, string | null]> = [
      [nf, null],
      [l1, nf],
      [l2, l1],
      [l3, l2],
      [l4, l3],
      [l5, l4],
      [s1, l1],
      [s2, l1],
      [orphan, randomUUID()],
      [c1, c2],
      [c2, c1],
    ];
    for (const [i, p] of rows)
      await pool.query('INSERT INTO organisations VALUES ($1, $2)', [i, p]);
    _setDbClients(pool as never, drizzle(pool) as never);
  }, 60_000);

  afterAll(async () => {
    _setDbClients(null, null);
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  const chain = async (orgId: string) => {
    const res = await new PostgresActorResolver().orgChain(orgId);
    if (!res.ok) throw new Error(res.error.message);
    return res.value;
  };

  it('walks five levels up to the root, target first', async () => {
    expect(await chain(l5)).toEqual([l5, l4, l3, l2, l1, nf]);
  });

  it('returns the root alone for the root', async () => {
    expect(await chain(nf)).toEqual([nf]);
  });

  it("keeps siblings out of each other's chain", async () => {
    expect(await chain(s1)).toEqual([s1, l1, nf]);
    expect(await chain(s1)).not.toContain(s2);
  });

  it('stops at a removed parent', async () => {
    expect(await chain(orphan)).toEqual([orphan]);
  });

  it('returns nothing for an unknown organisation', async () => {
    expect(await chain(randomUUID())).toEqual([]);
  });

  it('stays bounded on a cycle', async () => {
    const out = await chain(c1);
    expect(out[0]).toBe(c1);
    expect(out.length).toBeLessThanOrEqual(65);
  });
});
