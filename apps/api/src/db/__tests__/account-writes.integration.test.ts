/**
 * Real-Postgres integration tests for the typed identity links in
 * `db/account-writes.ts` (migration 0040, `@aggregator-dpg/api`): one login
 * may link one account per type. Runs only with `INTEGRATION_DATABASE_URL` set;
 * excluded from `pnpm -w test`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool, closeDb, _setDbClients } from '../client.js';
import { PostgresUserStore } from '../../services/user-store/postgres.js';
import { PostgresOrganisationStore } from '../../services/organisation-store/postgres.js';
import { permissiveTreeRules } from '../../services/organisation-store/testing.js';
import { PostgresIdentityStore } from '../../services/identity-store/postgres.js';
import { NO_CONSENT_WRITE } from '../../services/consent-ledger/hook.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
const CONSENT = {
  value: true,
  given_at: '2026-01-01T00:00:00.000Z',
  valid_till: '2027-01-01T00:00:00.000Z',
};

function phone(): string {
  return `+91${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
}
function email(): string {
  return `it-${randomUUID().slice(0, 8)}@example.org`;
}

suite('typed identity links (migration 0040) — integration', () => {
  let pool: pg.Pool;
  const userStore = new PostgresUserStore();
  const orgStore = new PostgresOrganisationStore();
  const identities = new PostgresIdentityStore();
  let defaultOrgId = '';

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_DIR });
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
    const d = await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`);
    defaultOrgId = d.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
  });

  async function newCoordinator(e = email(), p = phone()) {
    const r = await userStore.create({
      recordConsent: NO_CONSENT_WRITE,
      orgSlug: `it-${randomUUID().slice(0, 8)}`,
      name: 'IT Coordinator',
      type: null,
      contact: { name: 'Coord', email: e, phone: p },
      consent: CONSENT,
      createdBy: 'it',
      orgId: defaultOrgId,
      updatedBy: 'it',
    });
    if (!r.ok) throw new Error(`coordinator create failed: ${r.error.code}`);
    return r.value;
  }

  async function newOrg(ownerEmail = email(), ownerPhone = phone()) {
    const r = await orgStore.create(
      {
        recordConsent: NO_CONSENT_WRITE,
        slug: `it-org-${randomUUID().slice(0, 8)}`,
        displayName: `IT Org ${randomUUID().slice(0, 8)}`,
        ownerEmail,
        ownerPhone,
        ownerName: 'Owner',
      },
      permissiveTreeRules(),
    );
    if (!r.ok) throw new Error(`org create failed: ${r.error.code}`);
    return r.value;
  }

  /** An org owner (admin) and a coordinator on the same contact. */
  async function adminAndCoordinator() {
    const e = email();
    const p = phone();
    const coord = await newCoordinator(e, p);
    const org = await newOrg(e, p);
    return { coord, org, adminId: org.ownerUserId };
  }

  it('lets an admin and a coordinator share one login', async () => {
    const { coord, org, adminId } = await adminAndCoordinator();
    const sub = randomUUID();
    expect(await identities.link(adminId, 'keycloak', sub)).toEqual({ ok: true, value: 'linked' });
    expect(await identities.link(coord.id, 'keycloak', sub)).toEqual({
      ok: true,
      value: 'linked',
    });
    const rows = await pool.query(
      `SELECT user_type FROM user_identities WHERE subject = $1 ORDER BY user_type`,
      [sub],
    );
    expect(rows.rows.map((r) => r.user_type)).toEqual(['admin', 'coordinator']);
    await userStore.deleteById(coord.id);
    await orgStore.deleteById(org.id);
  });

  it('refuses a second coordinator on the same login (DUPLICATE)', async () => {
    const { coord, org, adminId } = await adminAndCoordinator();
    const other = await newCoordinator();
    const sub = randomUUID();
    await identities.link(adminId, 'keycloak', sub);
    await identities.link(coord.id, 'keycloak', sub);
    const dup = await identities.link(other.id, 'keycloak', sub);
    expect(dup.ok || dup.error.code).toBe('DUPLICATE');
    await userStore.deleteById(other.id);
    await userStore.deleteById(coord.id);
    await orgStore.deleteById(org.id);
  });

  it('resolves by type, preferring the admin when no type is given', async () => {
    const { coord, org, adminId } = await adminAndCoordinator();
    const sub = randomUUID();
    // Linked coordinator first, so the order is not insertion order.
    await identities.link(coord.id, 'keycloak', sub);
    await identities.link(adminId, 'keycloak', sub);
    expect(await identities.userOf('keycloak', sub)).toEqual({ ok: true, value: adminId });
    expect(await identities.userOf('keycloak', sub, 'admin')).toEqual({
      ok: true,
      value: adminId,
    });
    expect(await identities.userOf('keycloak', sub, 'coordinator')).toEqual({
      ok: true,
      value: coord.id,
    });
    expect(await identities.accountsOf('keycloak', sub)).toEqual({
      ok: true,
      value: { admin: adminId, coordinator: coord.id },
    });
    await userStore.deleteById(coord.id);
    await orgStore.deleteById(org.id);
  });

  it('resolves a coordinator-only login to the coordinator', async () => {
    const coord = await newCoordinator();
    const sub = randomUUID();
    await identities.link(coord.id, 'keycloak', sub);
    expect(await identities.userOf('keycloak', sub)).toEqual({ ok: true, value: coord.id });
    expect(await identities.userOf('keycloak', sub, 'admin')).toEqual({ ok: true, value: null });
    expect(await identities.accountsOf('keycloak', sub)).toEqual({
      ok: true,
      value: { admin: null, coordinator: coord.id },
    });
    await userStore.deleteById(coord.id);
  });

  it('fills user_type from the account when an insert leaves it out', async () => {
    const { coord, org, adminId } = await adminAndCoordinator();
    const sub = randomUUID();
    // The insert of an API image that predates the column.
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, subject) VALUES ($1, 'keycloak', $2), ($3, 'keycloak', $2)`,
      [adminId, sub, coord.id],
    );
    const rows = await pool.query(
      `SELECT user_id, user_type FROM user_identities WHERE subject = $1 ORDER BY user_type`,
      [sub],
    );
    expect(rows.rows).toEqual([
      { user_id: adminId, user_type: 'admin' },
      { user_id: coord.id, user_type: 'coordinator' },
    ]);
    await userStore.deleteById(coord.id);
    await orgStore.deleteById(org.id);
  });

  it('keeps user_type equal to the account type (composite FK)', async () => {
    const coord = await newCoordinator();
    await expect(
      pool.query(
        `INSERT INTO user_identities (user_id, user_type, provider, subject)
         VALUES ($1, 'admin', 'keycloak', $2)`,
        [coord.id, randomUUID()],
      ),
    ).rejects.toThrow(/user_identities_user_type_fk/);
    await userStore.deleteById(coord.id);
  });
});
