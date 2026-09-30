/**
 * Integration test for migration 0025 (`contact`) and the contact-aware stores,
 * against a live Postgres.
 *
 * Covers what the unit tests cannot: the SQL itself. Idempotent re-runs (the
 * pre-deploy script + the boot re-run), concurrent runners, the golden-vector
 * match between `contactId()` and `contact_id_of()`, the best-effort sync /
 * re-key / GC triggers under LEGACY writes (what the running N-1 release
 * does), the backfill leaving `updated_at` alone, and both stores reading
 * through the `contact` join.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set (the vitest config
 * force-sets a placeholder `DATABASE_URL`). Point it at a scratch database the
 * test may migrate and write to; every row it creates is removed or rolled
 * back:
 *
 *   INTEGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/aggregator_it \
 *     pnpm --filter @aggregator-dpg/api exec vitest run src/db/__tests__/contact.integration.test.ts
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { getDb, getPool, closeDb, _setDbClients } from '../client.js';
import { PostgresAggregatorStore } from '../../services/aggregator-store/postgres.js';
import { PostgresAggregatorOrgStore } from '../../services/aggregator-org-store/postgres.js';

const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
const CONSENT = {
  value: true,
  given_at: '2026-01-01T00:00:00.000Z',
  valid_till: '2027-01-01T00:00:00.000Z',
};

/** Unique, canonical test phone — `+91` + 10 digits. */
function phone(): string {
  return `+91${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
}

suite('contact (migration 0025) — integration', () => {
  let pool: pg.Pool;
  let sql0025: string;

  beforeAll(async () => {
    _setDbClients(null, null);
    getPool({ url: realUrl! });
    await migrate(getDb(), { migrationsFolder: MIGRATIONS });
    pool = new pg.Pool({ connectionString: realUrl, max: 4 });
    sql0025 = await readFile(path.join(MIGRATIONS, '0025_contact.sql'), 'utf8');
  });

  afterAll(async () => {
    await pool?.end();
    await closeDb();
  });

  /** Runs `fn` in a transaction that is always rolled back. */
  async function inRollback<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /** Applies 0025 exactly as `scripts/contact-migrate.sh apply` does. */
  async function apply0025(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql0025);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async function objectDefs(): Promise<string[]> {
    const r = await pool.query<{ d: string }>(`
      SELECT pg_get_triggerdef(t.oid) AS d FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgname LIKE '%contact%'
      UNION ALL
      SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conname LIKE '%contact%'
      ORDER BY 1`);
    return r.rows.map((x) => x.d);
  }

  it('is idempotent: re-applying 0025 twice changes nothing and raises nothing', async () => {
    const before = await objectDefs();
    await apply0025();
    await apply0025();
    expect(await objectDefs()).toEqual(before);
    const marker = await pool.query<{ m: string }>(
      `SELECT obj_description('public.contact'::regclass, 'pg_class') AS m`,
    );
    expect(marker.rows[0]!.m).toBe('contact-schema:v1');
  });

  it('serialises concurrent runners on the advisory lock (both succeed)', async () => {
    await expect(Promise.all([apply0025(), apply0025()])).resolves.toBeDefined();
  });

  it('contact_id_of() matches contactId() on the golden vectors', async () => {
    const vectors: Array<[string, string | null]> = [
      ['asha@example.org', '+919876543210'],
      ['owner@example.org', null],
      ['ZOË@example.org', '+919876543210'],
    ];
    for (const [email, ph] of vectors) {
      const r = await pool.query<{ id: string }>('SELECT contact_id_of($1, $2) AS id', [email, ph]);
      expect(r.rows[0]!.id).toBe(contactId(email, ph));
    }
  });

  describe('sync triggers under legacy (N-1) writes', () => {
    const insertCoordinator = (c: pg.PoolClient, slug: string, contact: object) =>
      c.query(
        `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
         VALUES ($1, 'aggregator', 'IT Org', $2, $3, 'it', 'it') RETURNING id, contact_id, contact_extra`,
        [slug, JSON.stringify(contact), JSON.stringify(CONSENT)],
      );

    it('links on insert, keeps extras, re-keys on a phone change, GCs on delete', () =>
      inRollback(async (c) => {
        const email = `it-${randomUUID().slice(0, 8)}@example.org`;
        const p1 = phone();
        const p2 = phone();
        const ins = await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
          name: 'Integration One',
          email: email.toUpperCase(),
          phone: p1,
          company: 'Acme',
        });
        const row = ins.rows[0] as { id: string; contact_id: string; contact_extra: object };
        expect(row.contact_id).toBe(contactId(email, p1));
        expect(row.contact_extra).toEqual({ company: 'Acme' });

        await c.query(
          `UPDATE aggregators SET contact = jsonb_set(contact, '{phone}', to_jsonb($2::text)) WHERE id = $1`,
          [row.id, p2],
        );
        const after = await c.query('SELECT contact_id FROM aggregators WHERE id = $1', [row.id]);
        expect(after.rows[0].contact_id).toBe(contactId(email, p2));
        const count = await c.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
          email,
        ]);
        expect(count.rows[0].n).toBe(1);

        await c.query('DELETE FROM aggregators WHERE id = $1', [row.id]);
        const gone = await c.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
          email,
        ]);
        expect(gone.rows[0].n).toBe(0);
      }));

    it('keeps the legacy duplicate error (constraint name) for coordinator duplicates', () =>
      inRollback(async (c) => {
        const email = `it-${randomUUID().slice(0, 8)}@example.org`;
        await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
          name: 'A',
          email,
          phone: phone(),
        });
        await c.query('SAVEPOINT dup');
        const err = await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
          name: 'B',
          email,
          phone: phone(),
        }).catch((e: { code?: string; constraint?: string }) => e);
        await c.query('ROLLBACK TO SAVEPOINT dup');
        expect((err as { code?: string }).code).toBe('23505');
        expect((err as { constraint?: string }).constraint).toBe(
          'aggregators_contact_email_unique',
        );
      }));

    it('never fails a legacy write on a cross-role clash — leaves the row unlinked', () =>
      inRollback(async (c) => {
        const shared = phone();
        await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
          name: 'Coordinator',
          email: `it-${randomUUID().slice(0, 8)}@example.org`,
          phone: shared,
        });
        const org = await c.query(
          `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
           VALUES ($1, $1, $2, $3) RETURNING contact_id`,
          [
            `it-org-${randomUUID().slice(0, 8)}`,
            `it-${randomUUID().slice(0, 8)}@example.org`,
            shared,
          ],
        );
        expect(org.rows[0].contact_id).toBeNull();
      }));

    it('one person holding both roles shares a single contact row', () =>
      inRollback(async (c) => {
        const email = `it-${randomUUID().slice(0, 8)}@example.org`;
        const p = phone();
        const a = await insertCoordinator(c, `it-${randomUUID().slice(0, 8)}`, {
          name: 'Both',
          email,
          phone: p,
        });
        const o = await c.query(
          `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
           VALUES ($1, $1, $2, $3) RETURNING contact_id`,
          [`it-org-${randomUUID().slice(0, 8)}`, email, p],
        );
        expect(o.rows[0].contact_id).toBe(a.rows[0].contact_id);
      }));
  });

  it('backfills an unlinked row on re-run without bumping updated_at', async () => {
    // A row written while the triggers were absent (e.g. by N-1 before the
    // pre-deploy script) — simulated by skipping triggers for one insert.
    const email = `it-${randomUUID().slice(0, 8)}@example.org`;
    const c = await pool.connect();
    let id: string;
    try {
      await c.query('SET session_replication_role = replica');
      const r = await c.query(
        `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by, updated_at)
         VALUES ($1, 'aggregator', 'IT Org', $2, $3, 'it', 'it', '2026-01-01T00:00:00Z') RETURNING id`,
        [
          `it-${randomUUID().slice(0, 8)}`,
          JSON.stringify({ name: 'Late', email, phone: phone() }),
          JSON.stringify(CONSENT),
        ],
      );
      id = r.rows[0].id;
      await c.query('SET session_replication_role = DEFAULT');
    } finally {
      c.release();
    }
    try {
      await apply0025();
      const r = await pool.query('SELECT contact_id, updated_at FROM aggregators WHERE id = $1', [
        id,
      ]);
      expect(r.rows[0].contact_id).not.toBeNull();
      expect(new Date(r.rows[0].updated_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      await pool.query('DELETE FROM aggregators WHERE id = $1', [id]);
    }
  });

  describe('stores read through the contact join', () => {
    it('aggregator store composes the Beckn contact and finds by email/phone', async () => {
      const store = new PostgresAggregatorStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const p = phone();
      const created = await store.create({
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        actorType: 'aggregator',
        name: 'IT Org',
        type: null,
        contact: { name: 'Store Test', email, phone: p, gstNumber: 'GST1' },
        consent: CONSENT,
        createdBy: 'it',
        updatedBy: 'it',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        expect(created.value.contactId).toBe(contactId(email, p));
        expect(created.value.contact).toEqual({
          name: 'Store Test',
          email,
          phone: p,
          gstNumber: 'GST1',
        });
        const byEmail = await store.findByContactEmail(email.toUpperCase());
        expect(byEmail.ok && byEmail.value?.id).toBe(created.value.id);
        const byPhone = await store.findByContactPhone(p);
        expect(byPhone.ok && byPhone.value?.id).toBe(created.value.id);

        const p2 = phone();
        const updated = await store.update(created.value.id, {
          contact: { name: 'Store Test', email, phone: p2 },
          updatedBy: 'it',
        });
        expect(updated.ok && updated.value.contactId).toBe(contactId(email, p2));
        expect(updated.ok && updated.value.contactPhone).toBe(p2);
      } finally {
        await store.deleteById(created.value.id);
      }
    });

    it('org store persists the owner name and finds by owner phone', async () => {
      const store = new PostgresAggregatorOrgStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const p = phone();
      const created = await store.create({
        slug: `it-org-${randomUUID().slice(0, 8)}`,
        displayName: `IT Org ${randomUUID().slice(0, 8)}`,
        ownerEmail: email.toUpperCase(),
        ownerPhone: p,
        ownerName: 'Owner Name',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        expect(created.value.ownerEmail).toBe(email);
        expect(created.value.ownerName).toBe('Owner Name');
        expect(created.value.contactId).toBe(contactId(email, p));
        const byPhone = await store.findByOwnerPhone(p);
        expect(byPhone.ok && byPhone.value?.id).toBe(created.value.id);
      } finally {
        await store.deleteById(created.value.id);
        const left = await pool.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
          email,
        ]);
        expect(left.rows[0].n).toBe(0);
      }
    });
  });

  describe('review fixes', () => {
    it('a failed re-key leaves no orphan contact behind (B1)', () =>
      inRollback(async (c) => {
        const ownerPhone = phone();
        await c.query(
          `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
           VALUES ($1, $1, $2, $3)`,
          [
            `it-org-${randomUUID().slice(0, 8)}`,
            `it-${randomUUID().slice(0, 8)}@example.org`,
            ownerPhone,
          ],
        );
        const email = `it-${randomUUID().slice(0, 8)}@example.org`;
        const ins = await c.query(
          `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
           VALUES ($1, 'aggregator', 'IT', $2, $3, 'it', 'it') RETURNING id`,
          [
            `it-${randomUUID().slice(0, 8)}`,
            JSON.stringify({ name: 'B1', email, phone: phone() }),
            JSON.stringify(CONSENT),
          ],
        );
        await c.query(
          `UPDATE aggregators SET contact = jsonb_set(contact, '{phone}', to_jsonb($2::text)) WHERE id = $1`,
          [ins.rows[0].id, ownerPhone],
        );
        const row = await c.query('SELECT contact_id FROM aggregators WHERE id = $1', [
          ins.rows[0].id,
        ]);
        expect(row.rows[0].contact_id).toBeNull();
        const left = await c.query('SELECT count(*)::int AS n FROM contact WHERE email = $1', [
          email,
        ]);
        expect(left.rows[0].n).toBe(0);
      }));

    it('stores names verbatim, blank as NULL (M3)', () =>
      inRollback(async (c) => {
        const padded = await c.query(`SELECT contact_link($1, $2, '  Asha  ') AS id`, [
          `it-${randomUUID().slice(0, 8)}@example.org`,
          phone(),
        ]);
        const blank = await c.query(`SELECT contact_link($1, $2, '   ') AS id`, [
          `it-${randomUUID().slice(0, 8)}@example.org`,
          phone(),
        ]);
        const names = await c.query('SELECT id, name FROM contact WHERE id = ANY($1)', [
          [padded.rows[0].id, blank.rows[0].id],
        ]);
        const byId = Object.fromEntries(
          names.rows.map((r: { id: string; name: string | null }) => [r.id, r.name]),
        );
        expect(byId[padded.rows[0].id]).toBe('  Asha  ');
        expect(byId[blank.rows[0].id]).toBeNull();
      }));

    it('a legacy-written row reads back byte-identical to its jsonb (D9)', async () => {
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const legacy = {
        name: ' Padded Name ',
        email,
        phone: phone(),
        company: 'Acme',
        gstNumber: 'G1',
      };
      const ins = await pool.query(
        `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
         VALUES ($1, 'aggregator', 'IT', $2, $3, 'it', 'it') RETURNING id, contact`,
        [`it-${randomUUID().slice(0, 8)}`, JSON.stringify(legacy), JSON.stringify(CONSENT)],
      );
      try {
        const found = await new PostgresAggregatorStore().findById(ins.rows[0].id);
        expect(found.ok).toBe(true);
        if (!found.ok || !found.value) return;
        expect(JSON.stringify(found.value.contact)).toBe(JSON.stringify(ins.rows[0].contact));
      } finally {
        await pool.query('DELETE FROM aggregators WHERE id = $1', [ins.rows[0].id]);
      }
    });

    it('an app-written row serialises exactly as the legacy jsonb would have (D9)', async () => {
      const store = new PostgresAggregatorStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const input = { name: 'Asha', email, phone: phone(), gstNumber: 'G1', company: 'Acme' };
      const created = await store.create({
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        actorType: 'aggregator',
        name: 'IT Org',
        type: null,
        contact: input,
        consent: CONSENT,
        createdBy: 'it',
        updatedBy: 'it',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      try {
        // What Postgres would have stored (and returned) for this object.
        const asJsonb = await pool.query('SELECT $1::jsonb AS j', [JSON.stringify(input)]);
        expect(JSON.stringify(created.value.contact)).toBe(JSON.stringify(asJsonb.rows[0].j));
        const raw = await pool.query('SELECT contact, contact_id FROM aggregators WHERE id = $1', [
          created.value.id,
        ]);
        expect(raw.rows[0].contact).toBeNull(); // legacy column no longer written
        expect(raw.rows[0].contact_id).toBe(contactId(email, input.phone));
      } finally {
        await store.deleteById(created.value.id);
      }
    });

    it('app writes are strict: a second person with the same email is DUPLICATE_EMAIL', async () => {
      const store = new PostgresAggregatorStore();
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const base = {
        actorType: 'aggregator' as const,
        name: 'IT Org',
        type: null,
        consent: CONSENT,
        createdBy: 'it',
        updatedBy: 'it',
      };
      const first = await store.create({
        ...base,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        contact: { name: 'A', email, phone: phone() },
      });
      expect(first.ok).toBe(true);
      const second = await store.create({
        ...base,
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        contact: { name: 'B', email, phone: phone() },
      });
      try {
        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.error.code).toBe('DUPLICATE_EMAIL');
      } finally {
        if (first.ok) await store.deleteById(first.value.id);
      }
    });

    it('refuses to re-key a contact shared by a coordinator and an org owner', async () => {
      const email = `it-${randomUUID().slice(0, 8)}@example.org`;
      const p = phone();
      const aggStore = new PostgresAggregatorStore();
      const orgStore = new PostgresAggregatorOrgStore();
      const coord = await aggStore.create({
        orgSlug: `it-${randomUUID().slice(0, 8)}`,
        actorType: 'aggregator',
        name: 'IT Org',
        type: null,
        contact: { name: 'Both', email, phone: p },
        consent: CONSENT,
        createdBy: 'it',
        updatedBy: 'it',
      });
      const org = await orgStore.create({
        slug: `it-org-${randomUUID().slice(0, 8)}`,
        displayName: `IT Org ${randomUUID().slice(0, 8)}`,
        ownerEmail: email,
        ownerPhone: p,
      });
      if (!coord.ok || !org.ok) throw new Error('setup failed');
      try {
        expect(coord.value.contactId).toBe(org.value.contactId);
        const moved = await aggStore.update(coord.value.id, {
          contact: { name: 'Both', email, phone: phone() },
          updatedBy: 'it',
        });
        expect(moved.ok).toBe(false);
        if (!moved.ok) expect(moved.error.code).toBe('DUPLICATE');
        const orgAfter = await orgStore.findById(org.value.id);
        expect(orgAfter.ok && orgAfter.value?.ownerPhone).toBe(p);
      } finally {
        await aggStore.deleteById(coord.value.id);
        await orgStore.deleteById(org.value.id);
      }
    });

    it('email/phone lookups can use the indexes (M2)', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL enable_seqscan = off');
        const plan = await c.query(
          `EXPLAIN SELECT a.id FROM aggregators a LEFT JOIN contact c ON c.id = a.contact_id
            WHERE a.contact_id = (SELECT id FROM contact WHERE phone = $1)
               OR (a.contact_id IS NULL AND a.contact_phone = $1)`,
          ['+910000000000'],
        );
        const text = plan.rows.map((r: Record<string, string>) => Object.values(r)[0]).join('\n');
        expect(text).not.toMatch(/Seq Scan on aggregators/);
        expect(text).toMatch(/contact_phone_unique/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('findByOwnerPhone ignores a half-created (inactive, no KC owner) org', async () => {
      const store = new PostgresAggregatorOrgStore();
      const p = phone();
      const created = await store.create({
        slug: `it-org-${randomUUID().slice(0, 8)}`,
        displayName: `IT Org ${randomUUID().slice(0, 8)}`,
        ownerEmail: `it-${randomUUID().slice(0, 8)}@example.org`,
        ownerPhone: p,
      });
      if (!created.ok) throw new Error('create failed');
      try {
        await store.update(created.value.id, { status: 'inactive' });
        const found = await store.findByOwnerPhone(p);
        expect(found.ok && found.value).toBeNull();
      } finally {
        await store.deleteById(created.value.id);
      }
    });
  });

  describe('final review fixes', () => {
    it('one coordinator row per person: two concurrent registrations of the same person', async () => {
      const store = new PostgresAggregatorStore();
      const person = {
        name: 'Twice',
        email: `it-${randomUUID().slice(0, 8)}@example.org`,
        phone: phone(),
      };
      const base = {
        actorType: 'aggregator' as const,
        name: 'IT Org',
        type: null,
        consent: CONSENT,
        createdBy: 'it',
        updatedBy: 'it',
      };
      const [a, b] = await Promise.all([
        store.create({ ...base, orgSlug: `it-${randomUUID().slice(0, 8)}`, contact: person }),
        store.create({ ...base, orgSlug: `it-${randomUUID().slice(0, 8)}`, contact: person }),
      ]);
      try {
        expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        const loser = a.ok ? b : a;
        if (!loser.ok) expect(['DUPLICATE_EMAIL', 'DUPLICATE_PHONE']).toContain(loser.error.code);
      } finally {
        if (a.ok) await store.deleteById(a.value.id);
        if (b.ok) await store.deleteById(b.value.id);
      }
    });

    it("a legacy write never merges one person onto another person's contact", () =>
      inRollback(async (c) => {
        const ownerEmail = `it-${randomUUID().slice(0, 8)}@example.org`;
        const ownerPhone = phone();
        await c.query(
          `INSERT INTO aggregator_orgs (slug, display_name, owner_email, owner_phone)
           VALUES ($1, $1, $2, $3)`,
          [`it-org-${randomUUID().slice(0, 8)}`, ownerEmail, ownerPhone],
        );
        await c.query(`UPDATE contact SET name = 'Owner Name' WHERE email = $1`, [ownerEmail]);
        const ins = await c.query(
          `INSERT INTO aggregators (org_slug, actor_type, name, contact, consent, created_by, updated_by)
           VALUES ($1, 'aggregator', 'IT', $2, $3, 'it', 'it') RETURNING id`,
          [
            `it-${randomUUID().slice(0, 8)}`,
            JSON.stringify({
              name: 'Intruder',
              email: `it-${randomUUID().slice(0, 8)}@example.org`,
              phone: phone(),
            }),
            JSON.stringify(CONSENT),
          ],
        );
        // A legacy PATCH to exactly the owner's email + phone.
        await c.query(
          `UPDATE aggregators SET contact = jsonb_build_object('name', 'Intruder', 'email', $2::text, 'phone', $3::text)
            WHERE id = $1`,
          [ins.rows[0].id, ownerEmail, ownerPhone],
        );
        const row = await c.query('SELECT contact_id FROM aggregators WHERE id = $1', [
          ins.rows[0].id,
        ]);
        expect(row.rows[0].contact_id).toBeNull(); // left unlinked, not merged
        const owner = await c.query('SELECT name FROM contact WHERE email = $1', [ownerEmail]);
        expect(owner.rows[0].name).toBe('Owner Name'); // never renamed
      }));
  });
});
