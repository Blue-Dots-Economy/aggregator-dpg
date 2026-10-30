/**
 * Integration test for the organisation store's tree rules against a live
 * Postgres at the head schema (`@aggregator-dpg/api`): limits on create and
 * revival, moves with the depth shift, "known as" checks, parent options,
 * counts, and the tree lock under concurrent writes.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP a scratch database (`orgtree_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { _setDbClients, closeDb, getPool } from '../../../db/client.js';
import { PostgresOrganisationStore } from '../postgres.js';
import { permissiveTreeRules } from '../testing.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';
import type { CreateOrgInput, OrgStoreResult } from '../interface.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../drizzle/migrations',
);
const TIMEOUT_MS = 120_000;

/** Waits `ms` milliseconds. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const code = (r: OrgStoreResult<unknown>) => (r.ok ? 'ok' : r.error.code);

suite('organisation store tree rules (Postgres)', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let dbName = '';
  const store = new PostgresOrganisationStore();
  let rootId = '';
  let defaultId = '';

  const input = (slug: string, parentId?: string): CreateOrgInput => ({
    slug,
    displayName: slug.toUpperCase(),
    ownerEmail: `${slug}@x.test`,
    recordConsent: NO_CONSENT_WRITE,
    ...(parentId === undefined ? {} : { parentId }),
  });

  /** Creates an org under permissive tree rules, deep enough for the descendant walk cap, and sets its status. */
  async function org(
    slug: string,
    parentId?: string,
    status: 'active' | 'pending' | 'inactive' = 'active',
  ): Promise<string> {
    const r = await store.create(input(slug, parentId), permissiveTreeRules({ maxDepth: 64 }));
    if (!r.ok) throw new Error(`seed ${slug} failed: ${r.error.code}`);
    if (status === 'active') await store.approve(r.value.id, 'test');
    if (status === 'inactive') await store.reject(r.value.id, 'test');
    return r.value.id;
  }

  async function depthOf(id: string): Promise<[string | null, number]> {
    const r = await pool.query<{ parent_id: string | null; depth: number }>(
      'SELECT parent_id, depth FROM organisations WHERE id = $1',
      [id],
    );
    return [r.rows[0]!.parent_id, r.rows[0]!.depth];
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    dbName = `orgtree_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({
      connectionString: url.toString(),
      max: 4,
      options: '-c aggregator_dpg.network=blue_dot',
    });
    pool.on('error', () => undefined);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    _setDbClients(null, null);
    getPool({ url: url.toString() }).on('error', () => undefined);
    const root = await store.findRoot();
    const def = await store.findDefault();
    if (!root.ok || !root.value || !def.ok || !def.value)
      throw new Error('root or Default missing');
    rootId = root.value.id;
    defaultId = def.value.id;
  }, TIMEOUT_MS);

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM organisations WHERE org_type = 'aggregator' AND slug <> 'default'`,
    );
  });

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (dbName) await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  describe('create', () => {
    it('sets depth from a nested parent and the suggested known_as', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const r = await store.create(
        input('n', b),
        permissiveTreeRules({ suggestFor: (depth) => `suggest-${depth}` }),
      );
      expect(r.ok && [r.value.depth, r.value.knownAs, r.value.parentId]).toEqual([
        3,
        'suggest-3',
        b,
      ]);
    });

    it('refuses INVALID_PARENT and DEPTH_LIMIT', async () => {
      const a = await org('a');
      expect(code(await store.create(input('n', defaultId), permissiveTreeRules()))).toBe(
        'INVALID_PARENT',
      );
      expect(code(await store.create(input('n', a), permissiveTreeRules({ maxDepth: 1 })))).toBe(
        'DEPTH_LIMIT',
      );
    });

    it('counts pending children, not rejected ones or the Default org', async () => {
      const c = await org('c');
      await org('p', c, 'pending');
      await org('x', c, 'inactive');
      expect(code(await store.create(input('n', c), permissiveTreeRules({ maxChildren: 1 })))).toBe(
        'CHILD_LIMIT',
      );
      // The root holds c and Default; only c counts.
      expect(code(await store.create(input('n'), permissiveTreeRules({ maxChildren: 2 })))).toBe(
        'ok',
      );
      expect(code(await store.create(input('m'), permissiveTreeRules({ maxChildren: 2 })))).toBe(
        'CHILD_LIMIT',
      );
    });

    it('refuses TOTAL_LIMIT counting pending orgs, not rejected ones or the Default org', async () => {
      await org('a');
      await org('p', undefined, 'pending');
      await org('x', undefined, 'inactive');
      expect(code(await store.create(input('n'), permissiveTreeRules({ maxTotalOrgs: 2 })))).toBe(
        'TOTAL_LIMIT',
      );
      expect(code(await store.create(input('n'), permissiveTreeRules({ maxTotalOrgs: 3 })))).toBe(
        'ok',
      );
    });

    it('lets one of two concurrent creates take the last child slot', async () => {
      const c = await org('c');
      const slow = (slug: string): CreateOrgInput => ({
        ...input(slug, c),
        recordConsent: () => sleep(200),
      });
      const results = await Promise.all([
        store.create(slow('r1'), permissiveTreeRules({ maxChildren: 1 })),
        store.create(slow('r2'), permissiveTreeRules({ maxChildren: 1 })),
      ]);
      expect(results.map(code).sort()).toEqual(['CHILD_LIMIT', 'ok']);
    });

    it('lets one of two concurrent creates take the last org slot', async () => {
      await org('a');
      const slow = (slug: string): CreateOrgInput => ({
        ...input(slug),
        recordConsent: () => sleep(200),
      });
      const results = await Promise.all([
        store.create(slow('r1'), permissiveTreeRules({ maxTotalOrgs: 2 })),
        store.create(slow('r2'), permissiveTreeRules({ maxTotalOrgs: 2 })),
      ]);
      expect(results.map(code).sort()).toEqual(['TOTAL_LIMIT', 'ok']);
    });
  });

  describe('revive', () => {
    it('sets a rejected org back to pending and clears rejected_at', async () => {
      const x = await org('x', undefined, 'inactive');
      const r = await store.revive(x, undefined, permissiveTreeRules());
      expect(r.ok && [r.value.status, r.value.rejectedAt]).toEqual(['pending', null]);
    });

    it('revives under the submitted parent and sets parent and depth from it', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const x = await org('x', undefined, 'inactive');
      const r = await store.revive(x, b, permissiveTreeRules());
      expect(r.ok && [r.value.parentId, r.value.parentName, r.value.depth]).toEqual([b, 'B', 3]);
      expect(await depthOf(x)).toEqual([b, 3]);
    });

    it('revives under the root when no parent is submitted', async () => {
      const a = await org('a');
      const x = await org('x', a, 'inactive');
      const r = await store.revive(x, undefined, permissiveTreeRules());
      expect(r.ok && [r.value.parentId, r.value.depth]).toEqual([rootId, 1]);
    });

    it('revives under a valid new parent when the stored parent is no longer active', async () => {
      const p = await org('p');
      const a = await org('a');
      const x = await org('x', p, 'inactive');
      await pool.query(`UPDATE organisations SET status = 'inactive' WHERE id = $1`, [p]);
      const r = await store.revive(x, a, permissiveTreeRules());
      expect(r.ok && [r.value.parentId, r.value.depth]).toEqual([a, 2]);
    });

    it('keeps known_as when allowed at the new depth and suggests one when not', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const x = await org('x', undefined, 'inactive');
      const y = await org('y', undefined, 'inactive');
      await pool.query(`UPDATE organisations SET known_as = 'block' WHERE id IN ($1, $2)`, [x, y]);
      const atTwo = permissiveTreeRules({
        knownAsAllowed: (key, depth) => key !== 'block' || depth === 2,
        suggestFor: (depth) => `suggest-${depth}`,
      });
      const kept = await store.revive(x, a, atTwo);
      expect(kept.ok && kept.value.knownAs).toBe('block');
      const suggested = await store.revive(y, b, atTwo);
      expect(suggested.ok && [suggested.value.depth, suggested.value.knownAs]).toEqual([
        3,
        'suggest-3',
      ]);
    });

    it('refuses CHILD_LIMIT, TOTAL_LIMIT, DEPTH_LIMIT and INVALID_PARENT', async () => {
      const c = await org('c');
      await org('y', c);
      const x = await org('x', undefined, 'inactive');
      expect(code(await store.revive(x, c, permissiveTreeRules({ maxChildren: 1 })))).toBe(
        'CHILD_LIMIT',
      );
      expect(code(await store.revive(x, c, permissiveTreeRules({ maxTotalOrgs: 2 })))).toBe(
        'TOTAL_LIMIT',
      );
      expect(code(await store.revive(x, c, permissiveTreeRules({ maxDepth: 1 })))).toBe(
        'DEPTH_LIMIT',
      );
      expect(code(await store.revive(x, defaultId, permissiveTreeRules()))).toBe('INVALID_PARENT');
      await pool.query(`UPDATE organisations SET status = 'inactive' WHERE id = $1`, [c]);
      expect(code(await store.revive(x, c, permissiveTreeRules()))).toBe('INVALID_PARENT');
      const still = await store.findById(x);
      expect(still.ok && [still.value?.status, still.value?.parentId]).toEqual([
        'inactive',
        rootId,
      ]);
    });

    it('refuses NOT_MOVABLE when the rejected org has child orgs', async () => {
      const a = await org('a');
      const x = await org('x', undefined, 'inactive');
      const z = await org('z');
      await pool.query(`UPDATE organisations SET parent_id = $1, depth = 2 WHERE id = $2`, [x, z]);
      expect(code(await store.revive(x, a, permissiveTreeRules()))).toBe('NOT_MOVABLE');
    });

    it('answers NOT_FOUND for an unknown or not rejected org', async () => {
      const a = await org('a');
      expect(code(await store.revive(a, undefined, permissiveTreeRules()))).toBe('NOT_FOUND');
      expect(
        code(
          await store.revive(
            '00000000-0000-0000-0000-000000000000',
            undefined,
            permissiveTreeRules(),
          ),
        ),
      ).toBe('NOT_FOUND');
    });
  });

  describe('move', () => {
    it('moves an org and shifts the depth of its subtree', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c');
      const r = await store.move(a, { parentId: c }, permissiveTreeRules());
      expect(r.ok && [r.value.movedCount, r.value.org.parentName, r.value.org.depth]).toEqual([
        2,
        'C',
        2,
      ]);
      expect(await depthOf(a)).toEqual([c, 2]);
      expect(await depthOf(b)).toEqual([a, 3]);
      expect(r.ok && r.value.oldParentId).toBe(rootId);
      const back = await store.move(b, { parentId: rootId }, permissiveTreeRules());
      expect(back.ok && back.value.org.depth).toBe(1);
    });

    it('refuses PARENT_CYCLE, INVALID_PARENT and NOT_MOVABLE', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const x = await org('x', undefined, 'inactive');
      expect(code(await store.move(a, { parentId: b }, permissiveTreeRules()))).toBe(
        'PARENT_CYCLE',
      );
      expect(code(await store.move(a, { parentId: a }, permissiveTreeRules()))).toBe(
        'PARENT_CYCLE',
      );
      expect(code(await store.move(a, { parentId: defaultId }, permissiveTreeRules()))).toBe(
        'INVALID_PARENT',
      );
      expect(code(await store.move(defaultId, { parentId: a }, permissiveTreeRules()))).toBe(
        'NOT_MOVABLE',
      );
      expect(code(await store.move(x, { parentId: a }, permissiveTreeRules()))).toBe('NOT_MOVABLE');
    });

    it('counts the subtree height against max depth, and refuses a full parent', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c');
      expect(code(await store.move(a, { parentId: c }, permissiveTreeRules({ maxDepth: 2 })))).toBe(
        'DEPTH_LIMIT',
      );
      await org('y', c);
      expect(
        code(await store.move(b, { parentId: c }, permissiveTreeRules({ maxChildren: 1 }))),
      ).toBe('CHILD_LIMIT');
    });

    it('rolls back with KNOWN_AS_DEPTH naming the orgs, leaving the tree unchanged', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c');
      await store.update(b, { knownAs: 'district' }, permissiveTreeRules());
      const r = await store.move(
        a,
        { parentId: c, knownAs: 'state' },
        permissiveTreeRules({
          knownAsAllowed: (k, d) => k === 'aggregator' || (k === 'district' && d === 2),
        }),
      );
      expect(!r.ok && r.error).toMatchObject({ code: 'KNOWN_AS_DEPTH' });
      expect(!r.ok && r.error.code === 'KNOWN_AS_DEPTH' && r.error.orgIds.sort()).toEqual(
        [a, b].sort(),
      );
      expect(await depthOf(a)).toEqual([rootId, 1]);
      expect(await depthOf(b)).toEqual([a, 2]);
      const aRow = await store.findById(a);
      expect(aRow.ok && aRow.value?.knownAs).toBe('aggregator');
    });

    it('is a no-op for the current parent; with known_as it changes only the value', async () => {
      const a = await org('a');
      const same = await store.move(a, { parentId: rootId }, permissiveTreeRules());
      expect(same.ok && same.value.movedCount).toBe(0);
      const named = await store.move(
        a,
        { parentId: rootId, knownAs: 'state' },
        permissiveTreeRules(),
      );
      expect(named.ok && [named.value.movedCount, named.value.org.knownAs]).toEqual([0, 'state']);
      const refused = await store.move(
        a,
        { parentId: rootId, knownAs: 'district' },
        permissiveTreeRules({ knownAsAllowed: (k) => k !== 'district' }),
      );
      expect(!refused.ok && refused.error).toMatchObject({ code: 'KNOWN_AS_DEPTH', orgIds: [a] });
    });

    it('answers ORG_BUSY at once when another transaction holds the org row', async () => {
      const a = await org('a');
      const c = await org('c');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM organisations WHERE id = $1 FOR UPDATE', [a]);
        const started = Date.now();
        expect(code(await store.move(a, { parentId: c }, permissiveTreeRules()))).toBe('ORG_BUSY');
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('answers NOT_FOUND for an unknown org', async () => {
      expect(
        code(
          await store.move(
            '00000000-0000-0000-0000-000000000000',
            { parentId: rootId },
            permissiveTreeRules(),
          ),
        ),
      ).toBe('NOT_FOUND');
    });
  });

  describe('update with known_as', () => {
    it('sets a value allowed at the stored depth and refuses one that is not', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const only1 = permissiveTreeRules({ knownAsAllowed: (k, d) => k !== 'state' || d === 1 });
      const ok = await store.update(a, { knownAs: 'state' }, only1);
      expect(ok.ok && ok.value.knownAs).toBe('state');
      const refused = await store.update(b, { knownAs: 'state' }, only1);
      expect(!refused.ok && refused.error).toMatchObject({ code: 'KNOWN_AS_DEPTH', orgIds: [b] });
    });

    it('saves no other field when the value is refused', async () => {
      const a = await org('a');
      const before = await store.findById(a);
      const r = await store.update(
        a,
        { displayName: 'Renamed', knownAs: 'state' },
        permissiveTreeRules({ knownAsAllowed: (k) => k !== 'state' }),
      );
      expect(!r.ok && r.error.code).toBe('KNOWN_AS_DEPTH');
      expect(await store.findById(a)).toEqual(before);
    });
  });

  describe('concurrent tree writes', () => {
    /**
     * Holds a SHARE lock on `organisations` while `run` starts its writes, so
     * every write that is not serialised by the tree lock reads the tree
     * before any of them can change it.
     */
    async function withWritesHeld<T>(run: () => Promise<T>): Promise<T> {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE organisations IN SHARE MODE');
        const pending = run();
        await sleep(300);
        await holder.query('COMMIT');
        return await pending;
      } finally {
        holder.release();
      }
    }

    it('lets only one of two crossing moves through, so no cycle forms', async () => {
      const a = await org('a');
      const b = await org('b');
      const results = await withWritesHeld(() =>
        Promise.all([
          store.move(a, { parentId: b }, permissiveTreeRules()),
          store.move(b, { parentId: a }, permissiveTreeRules()),
        ]),
      );
      expect(results.map(code).sort()).toEqual(['PARENT_CYCLE', 'ok']);
    });

    it('keeps known_as allowed at the depth when a known_as change races a move', async () => {
      const a = await org('a');
      const c = await org('c');
      const only1 = permissiveTreeRules({ knownAsAllowed: (k, d) => k !== 'state' || d === 1 });
      await withWritesHeld(async () => {
        const moved = store.move(a, { parentId: c }, only1);
        await sleep(100);
        const named = store.update(a, { knownAs: 'state' }, only1);
        return Promise.all([moved, named]);
      });
      const row = await store.findById(a);
      if (!row.ok || !row.value) throw new Error('org missing');
      expect(only1.knownAsAllowed(row.value.knownAs, row.value.depth)).toBe(true);
    });
  });

  describe('parentOptions', () => {
    it('lists the root and every other org with the result a move would give', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const c = await org('c');
      const p = await org('p', undefined, 'pending');
      const full = await org('full');
      const f1 = await org('f1', full);
      const r = await store.parentOptions(b, permissiveTreeRules({ maxDepth: 2, maxChildren: 1 }));
      if (!r.ok) throw new Error(r.error.code);
      expect(r.value.subtreeSize).toBe(1);
      const reasons = Object.fromEntries(
        r.value.options.map((o) => [o.org.id, o.ok ? 'ok' : o.reason]),
      );
      expect(reasons).toEqual({
        [a]: 'ok',
        [c]: 'ok',
        [p]: 'INVALID_PARENT',
        [full]: 'CHILD_LIMIT',
        [f1]: 'DEPTH_LIMIT',
        [defaultId]: 'INVALID_PARENT',
        [rootId]: 'CHILD_LIMIT',
      });
      expect(r.value.options.some((o) => o.org.id === b)).toBe(false);
    });
  });

  describe('parentOptions with known_as', () => {
    it('refuses with KNOWN_AS_DEPTH a parent that puts an org below at a depth its value does not allow', async () => {
      const a = await org('a');
      const b = await org('b', a);
      const e = await org('e');
      const c = await org('c');
      const r = permissiveTreeRules({
        knownAsAllowed: (k, d) => (k === 'state' ? d === 1 : k !== 'district' || d === 2),
      });
      await store.update(a, { knownAs: 'state' }, r);
      await store.update(b, { knownAs: 'district' }, r);
      await store.update(e, { knownAs: 'state' }, r);
      const reasonsOf = async (id: string) => {
        const res = await store.parentOptions(id, r);
        if (!res.ok) throw new Error(res.error.code);
        return Object.fromEntries(res.value.options.map((o) => [o.org.id, o.ok ? 'ok' : o.reason]));
      };
      expect(await reasonsOf(a)).toMatchObject({ [rootId]: 'ok', [c]: 'KNOWN_AS_DEPTH' });
      // The moved org's own value is not checked: the move can change it.
      expect(await reasonsOf(e)).toMatchObject({ [rootId]: 'ok', [c]: 'ok' });
    });
  });

  describe('counts and descendants', () => {
    it('childCounts and countTotal count pending and active orgs, Default excluded', async () => {
      const c = await org('c');
      await org('p', c, 'pending');
      await org('x', c, 'inactive');
      const r = await store.childCounts([rootId, c, defaultId]);
      expect(r).toEqual({ ok: true, value: { [rootId]: 1, [c]: 1, [defaultId]: 0 } });
      expect(await store.countTotal()).toEqual({ ok: true, value: 2 });
    });

    it('descendantIds stops 32 levels down', async () => {
      let parent = await org('n0');
      const top = parent;
      for (let i = 1; i <= 34; i++) parent = await org(`n${i}`, parent);
      const r = await store.descendantIds([top]);
      expect(r.ok && r.value.length).toBe(32);
    });
  });
});
