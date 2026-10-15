/**
 * Real-Postgres integration tests for migration 0030 (`permission`, `role`,
 * `role_permission`, `user_role`, `iam_audit`) and the Postgres catalogue
 * store (`@aggregator-dpg/api`). Runs only with `INTEGRATION_DATABASE_URL` set
 * (the `db-integration` CI job).
 *
 * Covers what a fake cannot: the migration from scratch, a sync that lands
 * once when replicas race, a revision that changes with every role edit,
 * custom roles surviving a sync, permission deprecation, and the table
 * constraints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  CAPABILITIES,
  loadRbacFile,
  permissionDefinitions,
  type RoleDefinition,
} from '@aggregator-dpg/rbac';
import { buildRole } from '@aggregator-dpg/rbac/testing';
import { getDb, getPool, closeDb, _setDbClients } from '../../../db/client.js';
import { PostgresRbacCatalogue } from '../postgres.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../../../../drizzle/migrations');
const SHIPPED = path.resolve(here, '../../../../../../config/rbac.yaml');
const PERMS = permissionDefinitions(CAPABILITIES);

suite('rbac catalogue (migration 0030) — integration', () => {
  let pool: pg.Pool;
  let builtins: RoleDefinition[];
  const store = new PostgresRbacCatalogue();

  async function revision(): Promise<string> {
    const r = await store.revision();
    return r.ok ? r.value : 'FAILED';
  }
  async function roleKeys(): Promise<string[]> {
    const l = await store.load();
    return l.ok ? l.value.roles.map((r) => r.key).sort() : [];
  }

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_DIR });
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
    builtins = (await loadRbacFile([SHIPPED])).roles;
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
  });

  it('creates the RBAC tables', async () => {
    const t = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('permission','role','role_permission','user_role','iam_audit') ORDER BY 1`,
    );
    expect(t.rows.map((r) => r.table_name)).toEqual([
      'iam_audit',
      'permission',
      'role',
      'role_permission',
      'user_role',
    ]);
  });

  it('syncs once when several replicas race, and audits it once', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => new PostgresRbacCatalogue().sync(PERMS, builtins, SHIPPED)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.value.changed > 0)).toHaveLength(1);
    const audit = await pool.query(`SELECT details FROM iam_audit WHERE event = 'catalogue.sync'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('loads back exactly the built-in roles of rbac.yaml', async () => {
    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.revision).toMatch(/^[0-9a-f]{32}$/);
    const byKey = (rs: RoleDefinition[]) => [...rs].sort((a, b) => a.key.localeCompare(b.key));
    expect(byKey(loaded.value.roles)).toEqual(
      byKey(builtins).map((r) => ({ ...r, permissions: [...r.permissions].sort() })),
    );
  });

  it('stores the permission catalogue with its fields', async () => {
    const p = await pool.query(`SELECT * FROM permission WHERE key = 'profiles.view_pii'`);
    expect(p.rows[0]).toMatchObject({
      resource: 'profiles',
      action: 'view_pii',
      sensitive: true,
      deprecated: false,
    });
    expect((await pool.query(`SELECT count(*)::int AS n FROM permission`)).rows[0].n).toBe(15);
  });

  it('changes the revision on a role edit and back on its reversal', async () => {
    const before = await revision();
    await pool.query(`INSERT INTO role_permission VALUES ('coordinator', 'profiles.export')`);
    expect(await revision()).not.toBe(before);
    await pool.query(
      `DELETE FROM role_permission WHERE role_key = 'coordinator' AND permission_key = 'profiles.export'`,
    );
    expect(await revision()).toBe(before);
  });

  it('keeps a custom role across a sync and resets an edited built-in role', async () => {
    const viewer = buildRole({ key: 'viewer', permissions: ['profiles.view'] });
    await pool.query(
      `INSERT INTO role (key, name, account_type, assignable_org_types, assigned_by)
       VALUES ('viewer', 'Viewer', 'coordinator', '{aggregator}', 'org.manage')`,
    );
    await pool.query(`INSERT INTO role_permission VALUES ('viewer', 'profiles.view')`);
    await pool.query(`INSERT INTO role_permission VALUES ('coordinator', 'profiles.export')`);
    const r = await store.sync(PERMS, builtins, SHIPPED);
    expect(r.ok && r.value.changed).toBeGreaterThan(0);
    expect(await roleKeys()).toContain(viewer.key);
    const coord = await pool.query(
      `SELECT array_agg(permission_key ORDER BY permission_key) AS p FROM role_permission WHERE role_key = 'coordinator'`,
    );
    expect(coord.rows[0].p).toEqual(['campaigns.run', 'profiles.onboard', 'profiles.view']);
  });

  it('writes nothing and audits nothing when already in sync', async () => {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM iam_audit`)).rows[0].n;
    const r = await store.sync(PERMS, builtins, SHIPPED);
    expect(r).toEqual({ ok: true, value: { changed: 0, retired: 0, keptInUse: [] } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM iam_audit`)).rows[0].n).toBe(before);
  });

  it('marks a permission the code dropped as deprecated, and restores it', async () => {
    const fewer = PERMS.filter((p) => p.key !== 'agreement.manage');
    const r = await store.sync(fewer, builtins, SHIPPED);
    expect(r.ok && r.value.retired).toBe(1);
    expect(
      (await pool.query(`SELECT deprecated FROM permission WHERE key = 'agreement.manage'`)).rows[0]
        .deprecated,
    ).toBe(true);
    const listed = await store.listPermissions();
    expect(listed.ok && listed.value.map((p) => p.key)).toEqual(
      PERMS.map((p) => p.key).sort((a, b) => a.localeCompare(b)),
    );
    expect(listed.ok && listed.value.find((p) => p.key === 'agreement.manage')).toMatchObject({
      deprecated: true,
    });
    await store.sync(PERMS, builtins, SHIPPED);
    expect(
      (await pool.query(`SELECT deprecated FROM permission WHERE key = 'agreement.manage'`)).rows[0]
        .deprecated,
    ).toBe(false);
  });

  it('removes a built-in role gone from the file unless it is assigned', async () => {
    const withExtra = [...builtins, { ...buildRole({ key: 'temp_builtin' }), isBuiltin: true }];
    await store.sync(PERMS, withExtra, SHIPPED);
    expect(await roleKeys()).toContain('temp_builtin');
    const r = await store.sync(PERMS, builtins, SHIPPED);
    expect(r.ok && r.value.retired).toBe(1);
    expect(await roleKeys()).not.toContain('temp_builtin');
  });

  it('enforces the role constraints', async () => {
    await expect(
      pool.query(
        `INSERT INTO role (key, name, account_type, base_for, assignable_org_types, is_builtin)
         VALUES ('c2', 'C2', 'coordinator', 'org_member', '{aggregator}', true)`,
      ),
    ).rejects.toThrow(/role_base_for_unique/);
    await expect(
      pool.query(
        `INSERT INTO role (key, name, account_type, assignable_org_types) VALUES ('x', 'X', 'coordinator', '{aggregator}')`,
      ),
    ).rejects.toThrow(/role_additional_shape_chk/);
    await expect(
      pool.query(
        `INSERT INTO role (key, name, account_type, assignable_org_types, assigned_by) VALUES ('Bad Key', 'X', 'coordinator', '{aggregator}', 'org.manage')`,
      ),
    ).rejects.toThrow(/role_key_chk/);
    await expect(
      pool.query(`INSERT INTO role_permission VALUES ('viewer', 'profiles.teleport')`),
    ).rejects.toThrow(/foreign key/);
    await expect(pool.query(`DELETE FROM permission WHERE key = 'profiles.view'`)).rejects.toThrow(
      /foreign key/,
    );
  });

  it('creates, changes and deletes a custom role, refusing while it is assigned', async () => {
    // The migrations seed the root's placeholder owner: an admin account.
    const admin: string = (
      await pool.query(`SELECT id FROM users WHERE user_type = 'admin' LIMIT 1`)
    ).rows[0]?.id;
    expect(admin).toBeTruthy();
    const def = (await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`)).rows[0]
      .id;
    const role = buildRole({ key: 'auditor', permissions: ['profiles.view'] });

    expect(await store.createRole(role, admin)).toEqual({ ok: true, value: { created: true } });
    expect(await store.createRole(role, admin)).toEqual({ ok: true, value: { created: false } });
    const changed = await store.updateRole(
      { ...role, permissions: ['profiles.verify', 'profiles.view'] },
      admin,
    );
    expect(changed).toEqual({ ok: true, value: { updated: true } });
    const loaded = await store.load();
    expect(loaded.ok && loaded.value.roles.find((r) => r.key === 'auditor')?.permissions).toEqual([
      'profiles.verify',
      'profiles.view',
    ]);
    expect(await store.updateRole({ ...builtins[0]!, isBuiltin: false }, admin)).toEqual({
      ok: true,
      value: { updated: false },
    });

    await pool.query(
      `INSERT INTO user_role (user_id, role_key, org_id) VALUES ($1, 'auditor', $2)`,
      [admin, def],
    );
    expect(await store.deleteRole('auditor', admin)).toEqual({ ok: true, value: 'in_use' });
    await pool.query(`UPDATE user_role SET revoked_at = now() WHERE role_key = 'auditor'`);
    expect(await store.deleteRole('auditor', admin)).toEqual({ ok: true, value: 'deleted' });
    expect(
      (await pool.query(`SELECT count(*)::int n FROM user_role WHERE role_key = 'auditor'`)).rows[0]
        .n,
    ).toBe(0);
    expect(await store.deleteRole('coordinator', admin)).toEqual({ ok: true, value: 'not_found' });
    const events = await pool.query(
      `SELECT event FROM iam_audit WHERE event LIKE 'catalogue.role.%' ORDER BY at`,
    );
    expect(events.rows.map((r) => r.event)).toEqual([
      'catalogue.role.create',
      'catalogue.role.update',
      'catalogue.role.delete',
    ]);
  });
});
