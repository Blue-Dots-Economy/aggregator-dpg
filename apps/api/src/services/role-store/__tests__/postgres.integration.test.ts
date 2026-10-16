/**
 * Real-Postgres integration tests for `user_role` (migration 0030) and the
 * Postgres role-assignment store (`@aggregator-dpg/api`). Runs only with
 * `INTEGRATION_DATABASE_URL` set (the `db-integration` CI job).
 *
 * Covers what a fake cannot: one live assignment per user, role and
 * organisation (partial unique index), the expiry check, the foreign keys to
 * `users`, `role` and `organisations`, and each write committing with its
 * audit row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { CAPABILITIES, loadRbacFile, permissionDefinitions } from '@aggregator-dpg/rbac';
import { getDb, getPool, closeDb, _setDbClients } from '../../../db/client.js';
import { PostgresUserStore } from '../../user-store/postgres.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';
import { PostgresRbacCatalogue } from '../../rbac-catalogue/postgres.js';
import { PostgresRoleStore } from '../postgres.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../../../../drizzle/migrations');
const SHIPPED = path.resolve(here, '../../../../../../config/rbac.yaml');
const DAY = 24 * 60 * 60 * 1000;

suite('role store (migration 0030) — integration', () => {
  let pool: pg.Pool;
  const store = new PostgresRoleStore();
  const aggStore = new PostgresUserStore();
  let defaultOrgId = '';

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_DIR });
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
    defaultOrgId = (await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`)).rows[0]
      .id;
    const { roles } = await loadRbacFile([SHIPPED]);
    await new PostgresRbacCatalogue().sync(permissionDefinitions(CAPABILITIES), roles, SHIPPED);
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
  });

  async function newCoordinator() {
    const r = await aggStore.create({
      recordConsent: NO_CONSENT_WRITE,
      orgSlug: `it-${randomUUID().slice(0, 8)}`,
      name: 'IT Coordinator',
      type: null,
      contact: {
        name: 'Coord',
        email: `it-${randomUUID().slice(0, 8)}@example.org`,
        phone: `+91${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`,
      },
      consent: {
        value: true,
        given_at: '2026-01-01T00:00:00.000Z',
        valid_till: '2027-01-01T00:00:00.000Z',
      },
      createdBy: 'it',
      orgId: defaultOrgId,
      updatedBy: 'it',
    });
    if (!r.ok) throw new Error(`coordinator create failed: ${r.error.code}`);
    return r.value;
  }

  it('assigns, replaces, lists and revokes, auditing each change', async () => {
    const c = await newCoordinator();
    const now = new Date();
    const input = {
      userId: c.id,
      roleKey: 'pii_access',
      orgId: defaultOrgId,
      grantedBy: c.id,
      expiresAt: new Date(now.getTime() + 90 * DAY),
    };
    const audit = { event: 'role.assign', actorUserId: c.id, targetUserId: c.id };
    const first = await store.assign(input, audit);
    const second = await store.assign(input, audit);
    expect(first.ok && second.ok).toBe(true);

    const live = await store.listLive(c.id, now);
    expect(live.ok && live.value.map((r) => r.id)).toEqual([second.ok ? second.value.id : '']);
    const all = await store.listForUser(c.id);
    expect(all.ok && all.value).toHaveLength(2);

    const revoke = { event: 'role.revoke', actorUserId: c.id, targetUserId: c.id };
    const revoked = await store.revoke(c.id, 'pii_access', defaultOrgId, c.id, revoke);
    expect(revoked.ok && revoked.value?.revokedAt).toBeInstanceOf(Date);
    expect(await store.revoke(c.id, 'pii_access', defaultOrgId, c.id, revoke)).toEqual({
      ok: true,
      value: null,
    });
    const events = await pool.query(
      `SELECT event FROM iam_audit WHERE target_user_id = $1 ORDER BY at`,
      [c.id],
    );
    expect(events.rows.map((r) => r.event)).toEqual(['role.assign', 'role.assign', 'role.revoke']);
  });

  it('treats a role without expiry as live and an expired one as not', async () => {
    const c = await newCoordinator();
    await store.assign(
      {
        userId: c.id,
        roleKey: 'data_export',
        orgId: defaultOrgId,
        grantedBy: c.id,
        expiresAt: null,
      },
      { event: 'role.assign', actorUserId: c.id, targetUserId: c.id },
    );
    const past = new Date(Date.now() - DAY);
    await pool.query(
      `INSERT INTO user_role (user_id, role_key, org_id, granted_at, expires_at)
       VALUES ($1, 'pii_access', $2, $3, $4)`,
      [c.id, defaultOrgId, new Date(past.getTime() - DAY), past],
    );
    const live = await store.listLive(c.id, new Date());
    expect(live.ok && live.value.map((r) => r.roleKey)).toEqual(['data_export']);
  });

  it('lists the live roles of several users in one read', async () => {
    const [a, b, other] = [await newCoordinator(), await newCoordinator(), await newCoordinator()];
    const audit = { event: 'role.assign', actorUserId: a.id };
    for (const [u, roleKey] of [
      [a, 'data_export'],
      [b, 'pii_access'],
      [other, 'data_export'],
    ] as const) {
      await store.assign(
        { userId: u.id, roleKey, orgId: defaultOrgId, grantedBy: a.id, expiresAt: null },
        audit,
      );
    }
    await store.revoke(b.id, 'pii_access', defaultOrgId, a.id, { ...audit, event: 'role.revoke' });

    const live = await store.listLiveForUsers([a.id, b.id], new Date());
    expect(live.ok && live.value.map((r) => [r.userId, r.roleKey])).toEqual([
      [a.id, 'data_export'],
    ]);
    expect(await store.listLiveForUsers([], new Date())).toEqual({ ok: true, value: [] });
  });

  it('revokes every live role in an organisation with one audit row', async () => {
    const c = await newCoordinator();
    for (const roleKey of ['pii_access', 'data_export']) {
      await store.assign(
        { userId: c.id, roleKey, orgId: defaultOrgId, grantedBy: c.id, expiresAt: null },
        { event: 'role.assign', actorUserId: c.id, targetUserId: c.id },
      );
    }
    const n = await store.revokeAllInOrg(c.id, defaultOrgId, null, {
      event: 'role.revoke_all',
      actorUserId: null,
      targetUserId: c.id,
    });
    expect(n).toEqual({ ok: true, value: 2 });
    expect((await store.listLive(c.id, new Date())).ok).toBe(true);
    const left = await store.listLive(c.id, new Date());
    expect(left.ok && left.value).toEqual([]);
  });

  it('allows one live assignment per user, role and organisation, and checks expiry', async () => {
    const c = await newCoordinator();
    const insert = `INSERT INTO user_role (user_id, role_key, org_id) VALUES ($1, 'data_export', $2)`;
    await pool.query(insert, [c.id, defaultOrgId]);
    await expect(pool.query(insert, [c.id, defaultOrgId])).rejects.toThrow(/user_role_live_unique/);
    await expect(
      pool.query(
        `INSERT INTO user_role (user_id, role_key, org_id, expires_at)
         VALUES ($1, 'pii_access', $2, now() - interval '1 day')`,
        [c.id, defaultOrgId],
      ),
    ).rejects.toThrow(/user_role_expiry_chk/);
  });

  it('references users, roles and organisations', async () => {
    const c = await newCoordinator();
    await expect(
      pool.query(`INSERT INTO user_role (user_id, role_key, org_id) VALUES ($1, 'gone', $2)`, [
        c.id,
        defaultOrgId,
      ]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      pool.query(
        `INSERT INTO user_role (user_id, role_key, org_id) VALUES ($1, 'data_export', $2)`,
        [randomUUID(), defaultOrgId],
      ),
    ).rejects.toThrow(/foreign key/);
    await pool.query(
      `INSERT INTO user_role (user_id, role_key, org_id) VALUES ($1, 'pii_access', $2)`,
      [c.id, defaultOrgId],
    );
    await expect(pool.query(`DELETE FROM role WHERE key = 'pii_access'`)).rejects.toThrow(
      /foreign key/,
    );
  });
});
