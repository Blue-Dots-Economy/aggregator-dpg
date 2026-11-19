/**
 * Integration test for {@link getConsentStatus} against a live Postgres at the
 * head schema (`@aggregator-dpg/api`): which `consent_record` rows count as an
 * acceptance of the current terms and privacy versions.
 *
 * Rows are inserted with random subject ids and no typed links, so each case
 * is isolated in the append-only table.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP a scratch database (`cstat_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { _setDbClients, closeDb, getPool } from '../../db/client.js';
import { getConsentStatus } from '../consent-status.js';
import { buildAdminActor, buildCoordinatorActor } from '../auth/actor/index.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
const TIMEOUT_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Row {
  subjectType: 'user' | 'organisation';
  subjectId: string;
  terms: number;
  privacy: number;
  source: string;
  validTill: Date | null;
}

suite('getConsentStatus (Postgres)', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let dbName = '';
  const current = { aggregator: { terms: 0, privacy: 0 }, org: { terms: 0, privacy: 0 } };
  const future = new Date(Date.now() + 365 * DAY_MS);
  const past = new Date(Date.now() - DAY_MS);

  async function insert(row: Row): Promise<void> {
    await pool.query(
      `INSERT INTO consent_record (subject_type, subject_id, terms_version, privacy_version,
                                   network, source, accepted_at, valid_till)
       VALUES ($1, $2, $3, $4, 'blue_dot', $5, now(), $6)`,
      [row.subjectType, row.subjectId, row.terms, row.privacy, row.source, row.validTill],
    );
  }

  /** A coordinator actor with a fresh user id, and a row writer for it. */
  function coordinator() {
    const actor = buildCoordinatorActor({ userId: randomUUID() });
    const write = (over: Partial<Row> = {}) =>
      insert({
        subjectType: 'user',
        subjectId: actor.userId,
        terms: current.aggregator.terms,
        privacy: current.aggregator.privacy,
        source: 'registration',
        validTill: future,
        ...over,
      });
    return { actor, write };
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    dbName = `cstat_${randomBytes(4).toString('hex')}`;
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

    const { network, brand } = resolveActiveNetwork();
    const cfg = await loadConsentConfig(network, brand);
    for (const audience of ['aggregator', 'org'] as const) {
      const docs = cfg.audiences[audience].documents;
      current[audience] = {
        terms: docs.terms.current_version,
        privacy: docs.privacy.current_version,
      };
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (dbName) await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('counts a registration row at the current versions with a future valid_till', async () => {
    const { actor, write } = coordinator();
    await write();
    const r = await getConsentStatus(actor);
    expect(r.success && r.value).toEqual({
      outstanding: false,
      audience: 'aggregator',
      termsVersion: current.aggregator.terms,
      privacyVersion: current.aggregator.privacy,
      outstandingOrgIds: [],
    });
  });

  it('does not count an older terms version', async () => {
    const { actor, write } = coordinator();
    await write({ terms: current.aggregator.terms - 1 });
    const r = await getConsentStatus(actor);
    expect(r.success && r.value.outstanding).toBe(true);
  });

  it('does not count an expired acceptance', async () => {
    const { actor, write } = coordinator();
    await write({ validTill: past });
    const r = await getConsentStatus(actor);
    expect(r.success && r.value.outstanding).toBe(true);
  });

  it('does not count a bulk-upload attestation at the current versions', async () => {
    const { actor, write } = coordinator();
    await write({ source: 'bulk_upload:x:v1', validTill: null });
    const r = await getConsentStatus(actor);
    expect(r.success && r.value.outstanding).toBe(true);
  });

  it('counts a first-login row', async () => {
    const { actor, write } = coordinator();
    await write({ source: 'first-login' });
    const r = await getConsentStatus(actor);
    expect(r.success && r.value.outstanding).toBe(false);
  });

  it('lists the owned orgs that have not accepted', async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const actor = buildAdminActor({
      userId: randomUUID(),
      orgs: [
        { id: orgA, orgType: 'aggregator', relation: 'owner', isDefault: false },
        { id: orgB, orgType: 'aggregator', relation: 'owner', isDefault: false },
      ],
    });
    await insert({
      subjectType: 'organisation',
      subjectId: orgA,
      terms: current.org.terms,
      privacy: current.org.privacy,
      source: 'registration',
      validTill: future,
    });
    const r = await getConsentStatus(actor);
    expect(r.success && r.value).toEqual({
      outstanding: true,
      audience: 'org',
      termsVersion: current.org.terms,
      privacyVersion: current.org.privacy,
      outstandingOrgIds: [orgB],
    });
  });
});
