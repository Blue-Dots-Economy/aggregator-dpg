/**
 * Real-Postgres integration tests for migration 0030 (RBAC grants) and the
 * Postgres grant store (`@aggregator-dpg/api`, R3). Runs only with
 * `INTEGRATION_DATABASE_URL` set (the `db-integration` CI job).
 *
 * Covers what a fake cannot: the migration from scratch, one live grant per
 * user and key (partial unique index), the expiry CHECK, the grant + audit
 * transaction, the org PermissionSet column, and the append-only audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool, closeDb, _setDbClients } from '../../../db/client.js';
import { PostgresAggregatorStore } from '../../aggregator-store/postgres.js';
import { PostgresAggregatorOrgStore } from '../../aggregator-org-store/postgres.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';
import { PostgresGrantStore } from '../postgres.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../drizzle/migrations',
);
const DAY = 24 * 60 * 60 * 1000;

suite('grant store (migration 0030) — integration', () => {
  let pool: pg.Pool;
  const store = new PostgresGrantStore();
  const aggStore = new PostgresAggregatorStore();
  const orgStore = new PostgresAggregatorOrgStore();
  let defaultOrgId = '';

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_DIR });
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
    defaultOrgId = (await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`)).rows[0]
      .id;
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

  it('grants, replaces, lists and revokes, auditing each change', async () => {
    const c = await newCoordinator();
    const now = new Date();
    const input = {
      userId: c.id,
      grantKey: 'pii_access',
      capability: 'profiles.view_pii' as const,
      grantedBy: c.id,
      expiresAt: new Date(now.getTime() + 90 * DAY),
    };
    const audit = { event: 'grant.create', actorUserId: c.id, targetUserId: c.id };
    const first = await store.grant(input, audit);
    const second = await store.grant(input, audit);
    expect(first.ok && second.ok).toBe(true);

    const live = await store.listLive(c.id, now);
    expect(live.ok && live.value.map((g) => g.id)).toEqual([second.ok ? second.value.id : '']);
    const all = await store.listForUser(c.id);
    expect(all.ok && all.value).toHaveLength(2);

    const revoked = await store.revoke(c.id, 'pii_access', c.id, {
      event: 'grant.revoke',
      actorUserId: c.id,
    });
    expect(revoked.ok && revoked.value?.revokedAt).toBeInstanceOf(Date);
    const again = await store.revoke(c.id, 'pii_access', c.id, {
      event: 'grant.revoke',
      actorUserId: c.id,
    });
    expect(again).toEqual({ ok: true, value: null });

    const events = await pool.query(
      `SELECT event FROM iam_audit WHERE target_user_id = $1 OR actor_user_id = $1 ORDER BY at`,
      [c.id],
    );
    expect(events.rows.map((r) => r.event)).toEqual([
      'grant.create',
      'grant.create',
      'grant.revoke',
    ]);
  });

  it('does not list an expired grant as live', async () => {
    const c = await newCoordinator();
    const past = new Date(Date.now() - DAY);
    await pool.query(
      `INSERT INTO user_permission_grant (user_id, grant_key, capability, granted_at, expires_at)
       VALUES ($1, 'pii_access', 'profiles.view_pii', $2, $3)`,
      [c.id, new Date(past.getTime() - DAY), past],
    );
    const live = await store.listLive(c.id, new Date());
    expect(live.ok && live.value).toEqual([]);
  });

  it('allows one live grant per user and key, and refuses an expiry before the grant', async () => {
    const c = await newCoordinator();
    const insert = `INSERT INTO user_permission_grant (user_id, grant_key, capability, expires_at)
                    VALUES ($1, 'pii_access', 'profiles.view_pii', now() + interval '1 day')`;
    await pool.query(insert, [c.id]);
    await expect(pool.query(insert, [c.id])).rejects.toThrow(/user_permission_grant_live_unique/);
    await expect(
      pool.query(
        `INSERT INTO user_permission_grant (user_id, grant_key, capability, expires_at)
         VALUES ($1, 'other', 'profiles.view_pii', now() - interval '1 day')`,
        [c.id],
      ),
    ).rejects.toThrow(/user_permission_grant_expiry_chk/);
  });

  it('keeps iam_audit append-only', async () => {
    const r = await store.recordAudit({
      event: 'org.permission_set',
      actorUserId: null,
      details: { to: null },
    });
    expect(r.ok).toBe(true);
    await expect(pool.query(`UPDATE iam_audit SET event = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM iam_audit`)).rejects.toThrow(/append-only/);
  });

  it('stores an organisation PermissionSet through the org store', async () => {
    const updated = await orgStore.update(defaultOrgId, {
      permissionSet: 'super_aggregator',
      updatedBy: 'it',
    });
    expect(updated.ok && updated.value.permissionSet).toBe('super_aggregator');
    const cleared = await orgStore.update(defaultOrgId, { permissionSet: null, updatedBy: 'it' });
    expect(cleared.ok && cleared.value.permissionSet).toBeNull();
  });
});
