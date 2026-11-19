/**
 * Integration test for the org-loader command (`@aggregator-dpg/api`,
 * `tools/org-loader.ts`) against a live Postgres at the head schema, with
 * fake Keycloak and Signals: a fresh three-level load leaves the V1 consent
 * gate of `scripts/sql/cleanup-verify.sql` at 0, stamps every created row
 * `provisioned:<operator>` and writes no consent row; a rerun skips every
 * row; half-created orgs (one whose owner's contact and admin account stay
 * behind because the owner owns another org) and a half-created coordinator
 * are removed and created again.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP a scratch database (`orgl_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { _setDbClients, closeDb, getPool } from '../../db/client.js';
import { IdpAdminFake, _setIdpAdmin } from '../../services/idp-admin/index.js';
import { PostgresIdentityStore, _setIdentityStore } from '../../services/identity-store/index.js';
import { PostgresRoleStore, _setRoleStore } from '../../services/role-store/index.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { _setSignalStackWriter } from '../../services/signalstack.js';
import {
  PostgresOrganisationStore,
  _setOrganisationStore,
} from '../../services/organisation-store/index.js';
import { permissiveTreeRules } from '../../services/organisation-store/testing.js';
import { PostgresUserStore, _setUserStore } from '../../services/user-store/index.js';
import { _setConsentLedger } from '../../services/consent-ledger/index.js';
import { _main } from '../org-loader.js';

vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'nf-admin@test.local';
});

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../../drizzle/migrations');
const VERIFY_SQL = path.resolve(HERE, '../../../../../scripts/sql/cleanup-verify.sql');
const TIMEOUT_MS = 120_000;
const OPERATOR = 'ops';
const PROVISIONED = 'provisioned:ops';

const ORGS = [
  'name,parent,owner_name,owner_phone,owner_email',
  'Top,,Ravi Kumar,9876500001,ravi@alpha.org',
  'Child,Top,Ravi Kumar,9876500001,ravi@alpha.org',
  'Leaf,Child,Meena Rao,9876500002,meena@alpha.org',
];
const COORDINATORS = [
  'org,name,phone,email,profile_types',
  'Top,Asha Kumari,9876511111,asha@alpha.org,seeker',
  'Leaf,Bina Das,9876511112,bina@alpha.org,seeker;provider',
];

interface ReportLine {
  kind: string;
  outcome: string;
  orgId: string;
  userId: string;
  errorCode: string;
}

suite('org-loader (Postgres)', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let dbName = '';
  let dir = '';
  let reportN = 0;
  const idp = new IdpAdminFake();
  const mailer = new FakeMailer();
  const orgStore = new PostgresOrganisationStore();
  const userStore = new PostgresUserStore();

  async function csv(name: string, lines: string[]): Promise<string> {
    const p = path.join(dir, name);
    await writeFile(p, `${lines.join('\n')}\n`);
    return p;
  }

  /** Runs `apply` in-process; returns the exit code and the parsed report. */
  async function apply(
    orgs: string[] | null,
    coordinators: string[] | null,
  ): Promise<{ code: number; rows: ReportLine[] }> {
    reportN += 1;
    const report = path.join(dir, `report-${reportN}.csv`);
    const args = ['apply', '--operator', OPERATOR, '--report', report];
    if (orgs) args.push('--orgs', await csv(`orgs-${reportN}.csv`, orgs));
    if (coordinators) {
      args.push('--coordinators', await csv(`coordinators-${reportN}.csv`, coordinators));
    }
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let code: number;
    try {
      code = await _main(args);
    } finally {
      spy.mockRestore();
    }
    const [header = '', ...lines] = (await readFile(report, 'utf8')).trim().split('\n');
    const cols = header.split(',');
    const at = (cells: string[], name: string) => cells[cols.indexOf(name)] ?? '';
    const rows = lines.map((l) => {
      const cells = l.split(',');
      return {
        kind: at(cells, 'kind'),
        outcome: at(cells, 'outcome'),
        orgId: at(cells, 'orgId'),
        userId: at(cells, 'userId'),
        errorCode: at(cells, 'errorCode'),
      };
    });
    return { code, rows };
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const r = await pool.query<{ n: string }>(sql, params);
    return Number(r.rows[0]?.n ?? -1);
  }

  async function v1(): Promise<number> {
    const script = await readFile(VERIFY_SQL, 'utf8');
    const stmt = script.slice(script.indexOf("SELECT 'V1"), script.indexOf('-- V2')).trim();
    const r = await pool.query<{ n: string }>(stmt.replace(/;$/, ''));
    return Number(r.rows[0]?.n ?? -1);
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    dbName = `orgl_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({
      connectionString: url.toString(),
      max: 2,
      options: '-c aggregator_dpg.network=blue_dot',
    });
    pool.on('error', () => undefined);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    _setDbClients(null, null);
    getPool({ url: url.toString() }).on('error', () => undefined);

    _setOrganisationStore(null);
    _setUserStore(null);
    _setConsentLedger(null);
    _setIdentityStore(new PostgresIdentityStore());
    _setRoleStore(new PostgresRoleStore());
    _setIdpAdmin(idp);
    _setSignalStackWriter(new SignalStackWriterFake());
    _setMailer(mailer);
    const base = buildBlueDotConfig();
    _setNetworkConfig(
      buildBlueDotConfig({
        aggregator: {
          ...base.aggregator,
          organisation: { hierarchy: { max_depth: 5, max_total_orgs: 50 } },
        },
      }),
    );
    dir = await mkdtemp(path.join(os.tmpdir(), 'org-loader-it-'));
  }, TIMEOUT_MS);

  afterAll(async () => {
    _setIdentityStore(null);
    _setRoleStore(null);
    _setIdpAdmin(null);
    _setSignalStackWriter(null);
    _setNetworkConfig(null);
    if (dir) await rm(dir, { recursive: true, force: true });
    await closeDb().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (dbName) await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it(
    'loads a three-level tree: V1 stays 0, every row is provisioned, no consent and no mail',
    async () => {
      const { code, rows } = await apply(ORGS, COORDINATORS);
      expect(code).toBe(0);
      expect(rows.map((r) => `${r.kind}:${r.outcome}`)).toEqual([
        'org:created',
        'org:created',
        'org:created',
        'coordinator:created',
        'coordinator:created',
      ]);

      expect(await v1()).toBe(0);

      const orgIds = rows.filter((r) => r.kind === 'org').map((r) => r.orgId);
      const userIds = [...new Set(rows.map((r) => r.userId))];
      expect(userIds).toHaveLength(4);
      expect(
        await count(
          `SELECT count(*) AS n FROM organisations WHERE id = ANY($1::uuid[])
              AND status = 'active' AND created_by LIKE 'provisioned:%' AND updated_by LIKE 'provisioned:%'`,
          [orgIds],
        ),
      ).toBe(3);
      expect(
        await count(
          `SELECT count(*) AS n FROM users WHERE id = ANY($1::uuid[]) AND created_by LIKE 'provisioned:%'`,
          [userIds],
        ),
      ).toBe(4);
      expect(
        await count(
          `SELECT count(*) AS n FROM users WHERE user_type = 'coordinator' AND status = 'active'
              AND created_by = $1`,
          [PROVISIONED],
        ),
      ).toBe(2);
      expect(
        await count(
          `SELECT count(*) AS n FROM consent_record WHERE user_id = ANY($1::uuid[]) OR org_id = ANY($2::uuid[])`,
          [userIds, orgIds],
        ),
      ).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM consent_record`)).toBe(0);
      expect(mailer.outbox).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  it(
    'reruns with exit 0 and every row already_loaded',
    async () => {
      const { code, rows } = await apply(ORGS, COORDINATORS);
      expect(code).toBe(0);
      expect(rows.map((r) => r.outcome)).toEqual(Array(5).fill('already_loaded'));
      expect(await v1()).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'recreates a half-created org with a new owner',
    async () => {
      const seeded = await orgStore.create(
        {
          slug: 'second-old',
          displayName: 'Second',
          ownerEmail: 'kiran@beta.org',
          ownerPhone: '+919876500003',
          ownerName: 'Kiran Shah',
          createdBy: PROVISIONED,
        },
        permissiveTreeRules(),
      );
      if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.code}`);
      // A process killed here leaves the org pending with no group and no owner login.
      expect(await count(`SELECT count(*) AS n FROM contact WHERE email = 'kiran@beta.org'`)).toBe(
        1,
      );

      const { code, rows } = await apply(
        [ORGS[0] ?? '', 'Second,,Kiran Shah,9876500003,kiran@beta.org'],
        null,
      );
      expect(code).toBe(0);
      expect(rows.map((r) => r.outcome)).toEqual(['resumed']);
      expect(rows[0]?.orgId).not.toBe(seeded.value.id);
      expect(
        await count(`SELECT count(*) AS n FROM organisations WHERE id = $1`, [seeded.value.id]),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*) AS n FROM organisations WHERE id = $1 AND status = 'active'
              AND created_by = $2 AND kc_group_id IS NOT NULL`,
          [rows[0]?.orgId, PROVISIONED],
        ),
      ).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM contact WHERE email = 'kiran@beta.org'`)).toBe(
        1,
      );
      expect(await v1()).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'recreates a half-created org over the contact and admin account its shared owner keeps',
    async () => {
      const seeded = await orgStore.create(
        {
          slug: 'third-old',
          displayName: 'Third',
          ownerEmail: 'ravi@alpha.org',
          ownerPhone: '+919876500001',
          ownerName: 'Ravi Kumar',
          createdBy: PROVISIONED,
        },
        permissiveTreeRules(),
      );
      if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.code}`);
      const owner = await pool.query<{ org_owner: string }>(
        `SELECT org_owner FROM organisations WHERE name = 'Top'`,
      );
      const ownerId = owner.rows[0]?.org_owner;
      expect(seeded.value.ownerUserId).toBe(ownerId);

      const { code, rows } = await apply(
        [ORGS[0] ?? '', 'Third,Top,Ravi Kumar,9876500001,ravi@alpha.org'],
        null,
      );
      expect(code).toBe(0);
      expect(rows.map((r) => r.outcome)).toEqual(['resumed']);
      expect(rows[0]?.orgId).not.toBe(seeded.value.id);
      // The delete left Ravi's admin account and contact in place; the recreate reused them.
      expect(rows[0]?.userId).toBe(ownerId);
      expect(
        await count(
          `SELECT count(*) AS n FROM organisations WHERE id = $1 AND status = 'active'
              AND org_owner = $2 AND created_by = $3 AND kc_group_id IS NOT NULL`,
          [rows[0]?.orgId, ownerId, PROVISIONED],
        ),
      ).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM contact WHERE email = 'ravi@alpha.org'`)).toBe(
        1,
      );
      expect(
        await count(`SELECT count(*) AS n FROM users WHERE user_type = 'admin' AND id = $1`, [
          ownerId,
        ]),
      ).toBe(1);
      expect(await v1()).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'recreates a half-created coordinator',
    async () => {
      const top = await pool.query<{ id: string }>(
        `SELECT id FROM organisations WHERE name = 'Top'`,
      );
      const topId = top.rows[0]?.id ?? '';
      const seeded = await userStore.create({
        name: 'Top',
        type: 'seeker',
        serves: ['seeker'],
        contact: { name: 'Chetan Rao', email: 'chetan@alpha.org', phone: '+919876511113' },
        createdBy: PROVISIONED,
        updatedBy: PROVISIONED,
        orgId: topId,
        orgSlug: 'top-chetan-old',
        legacyOrgDetails: null,
        locations: [],
        inviteId: null,
        profile: {},
        profileRef: null,
      });
      if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.code}`);
      // A process killed here leaves the coordinator pending with no Keycloak user.

      const { code, rows } = await apply(null, [
        COORDINATORS[0] ?? '',
        'Top,Chetan Rao,9876511113,chetan@alpha.org,seeker',
      ]);
      expect(code).toBe(0);
      expect(rows.map((r) => r.outcome)).toEqual(['resumed']);
      expect(rows[0]?.userId).not.toBe(seeded.value.id);
      expect(await count(`SELECT count(*) AS n FROM users WHERE id = $1`, [seeded.value.id])).toBe(
        0,
      );
      expect(
        await count(
          `SELECT count(*) AS n FROM users WHERE id = $1 AND status = 'active' AND created_by = $2
              AND signalstack_org_id IS NOT NULL`,
          [rows[0]?.userId, PROVISIONED],
        ),
      ).toBe(1);
      expect(
        await count(`SELECT count(*) AS n FROM contact WHERE email = 'chetan@alpha.org'`),
      ).toBe(1);
      expect(await v1()).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM consent_record`)).toBe(0);
    },
    TIMEOUT_MS,
  );
});
