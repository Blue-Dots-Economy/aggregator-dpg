/**
 * Integration test for {@link acceptCurrentTerms} against a live Postgres at
 * the head schema (`@aggregator-dpg/api`): the `first-login` rows it writes,
 * the all-or-nothing transaction across an owner's orgs, and the refusal of
 * stale versions.
 *
 * Coordinators and orgs are created through the stores without a consent row,
 * so each case starts with an outstanding acceptance.
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set; the URL is only used to
 * CREATE / DROP a scratch database (`cacc_<random>`), so its role needs
 * CREATEDB.
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  ConsentLedgerBase,
  type RecordConsentInput,
} from '@aggregator-dpg/consent-ledger/interface';
import { PostgresConsentLedger } from '@aggregator-dpg/consent-ledger/postgres';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err } from '@aggregator-dpg/shared-primitives/result';
import { _setDbClients, closeDb, getDb, getPool } from '../../db/client.js';
import { acceptCurrentTerms } from '../consent-accept.js';
import { getConsentStatus } from '../consent-status.js';
import { _setConsentLedger } from '../consent-ledger/index.js';
import { MAX_CONSENT_VALIDITY_MS } from '../registration-consent.js';
import { PostgresUserStore } from '../user-store/postgres.js';
import { PostgresOrganisationStore } from '../organisation-store/postgres.js';
import { permissiveTreeRules } from '../organisation-store/testing.js';
import { buildAdminActor, buildCoordinatorActor, type Actor } from '../auth/actor/index.js';

const adminUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);
const TIMEOUT_MS = 120_000;
const CONSENT = {
  value: true as const,
  given_at: '2026-06-01T00:00:00.000Z',
  valid_till: '2027-06-01T00:00:00.000Z',
};

/** Stores create the account without a ledger row. */
const noConsent = async (): Promise<void> => undefined;

function phone(): string {
  return `+91${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
}
function email(): string {
  return `cacc-${randomUUID().slice(0, 8)}@example.org`;
}

/** A ledger whose `nth` write in a transaction fails; the others go to Postgres. */
class FailingNthLedger extends ConsentLedgerBase {
  constructor(
    private readonly inner: PostgresConsentLedger,
    private readonly nth: number,
    private calls = { n: 0 },
  ) {
    super();
  }
  override async recordRegistrationConsent(input: RecordConsentInput) {
    this.calls.n += 1;
    if (this.calls.n === this.nth) {
      return err(new UpstreamError('ledger down', { code: 'CONSENT_INSERT_FAILED' }));
    }
    return this.inner.recordRegistrationConsent(input);
  }
  override withExecutor(executor: unknown): ConsentLedgerBase {
    return new FailingNthLedger(this.inner.withExecutor(executor), this.nth, { n: 0 });
  }
}

suite('acceptCurrentTerms (Postgres)', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let dbName = '';
  let defaultOrgId = '';
  const userStore = new PostgresUserStore();
  const orgStore = new PostgresOrganisationStore();

  const rowsOf = async (subjectIds: string[]) =>
    (
      await pool.query(
        `SELECT subject_type, subject_id, source, terms_version, privacy_version, valid_till
           FROM consent_record WHERE subject_id = ANY($1::uuid[])`,
        [subjectIds],
      )
    ).rows;

  /** A coordinator with no consent row. */
  async function coordinator(): Promise<Actor> {
    const r = await userStore.create({
      orgSlug: `cacc-${randomUUID().slice(0, 8)}`,
      name: 'Coordinator',
      type: 'seeker',
      contact: { name: 'Coord', email: email(), phone: phone() },
      consent: CONSENT,
      recordConsent: noConsent,
      createdBy: 'it',
      updatedBy: 'it',
      orgId: defaultOrgId,
    });
    if (!r.ok) throw new Error(`coordinator seed failed: ${r.error.code}`);
    return buildCoordinatorActor({ userId: r.value.id });
  }

  /** An org with no consent row. */
  async function org(): Promise<string> {
    const r = await orgStore.create(
      {
        slug: `cacc-org-${randomUUID().slice(0, 8)}`,
        displayName: `Org ${randomUUID().slice(0, 8)}`,
        ownerEmail: email(),
        ownerPhone: phone(),
        recordConsent: noConsent,
      },
      permissiveTreeRules(),
    );
    if (!r.ok) throw new Error(`org seed failed: ${r.error.code}`);
    return r.value.id;
  }

  function ownerOf(...orgIds: string[]): Actor {
    return buildAdminActor({
      userId: randomUUID(),
      orgs: orgIds.map((id) => ({
        id,
        orgType: 'aggregator' as const,
        relation: 'owner' as const,
        isDefault: false,
      })),
    });
  }

  /** The versions the caller was shown: the current ones of its audience. */
  async function shownFor(actor: Actor) {
    const s = await getConsentStatus(actor);
    if (!s.success) throw s.error;
    return { termsVersion: s.value.termsVersion, privacyVersion: s.value.privacyVersion };
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    dbName = `cacc_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    pool.on('error', () => undefined);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    _setDbClients(null, null);
    getPool({ url: url.toString() }).on('error', () => undefined);
    defaultOrgId = (await pool.query(`SELECT id FROM organisations WHERE slug = 'default'`)).rows[0]
      .id;
  }, TIMEOUT_MS);

  afterEach(() => {
    _setConsentLedger(null);
  });

  afterAll(async () => {
    _setConsentLedger(null);
    await closeDb().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (dbName) await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('records one first-login row for a coordinator, valid for the maximum period', async () => {
    const actor = await coordinator();
    const shown = await shownFor(actor);
    const now = new Date();
    const r = await acceptCurrentTerms(actor, shown, now);
    expect(r.success && r.value).toEqual({ recorded: 1 });

    const rows = await rowsOf([actor.userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_type: 'user',
      subject_id: actor.userId,
      source: 'first-login',
      terms_version: shown.termsVersion,
      privacy_version: shown.privacyVersion,
    });
    expect((rows[0].valid_till as Date).getTime()).toBe(now.getTime() + MAX_CONSENT_VALIDITY_MS);

    const after = await getConsentStatus(actor);
    expect(after.success && after.value.outstanding).toBe(false);
  });

  it('records only the owned orgs that have not accepted', async () => {
    const [orgA, orgB] = await Promise.all([org(), org()]);
    const ownerA = ownerOf(orgA);
    expect(await acceptCurrentTerms(ownerA, await shownFor(ownerA))).toMatchObject({
      success: true,
      value: { recorded: 1 },
    });

    const owner = ownerOf(orgA, orgB);
    const r = await acceptCurrentTerms(owner, await shownFor(owner));
    expect(r.success && r.value).toEqual({ recorded: 1 });

    const rows = await rowsOf([orgA, orgB]);
    expect(rows.filter((x) => x.subject_id === orgA)).toHaveLength(1);
    expect(rows.filter((x) => x.subject_id === orgB)).toEqual([
      expect.objectContaining({ subject_type: 'organisation', source: 'first-login' }),
    ]);
  });

  it('records nothing when one of several org writes fails', async () => {
    const [orgA, orgB] = await Promise.all([org(), org()]);
    const owner = ownerOf(orgA, orgB);
    const shown = await shownFor(owner);
    _setConsentLedger(new FailingNthLedger(new PostgresConsentLedger(getDb()), 2));

    const r = await acceptCurrentTerms(owner, shown);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('DB_UNAVAILABLE');
    expect(await rowsOf([orgA, orgB])).toHaveLength(0);
  });

  it('refuses versions that are not the current ones and records nothing', async () => {
    const actor = await coordinator();
    const shown = await shownFor(actor);
    const r = await acceptCurrentTerms(actor, {
      termsVersion: shown.termsVersion + 1,
      privacyVersion: shown.privacyVersion,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('CONSENT_VERSION_CHANGED');
    expect(await rowsOf([actor.userId])).toHaveLength(0);
  });

  it('records nothing the second time', async () => {
    const actor = await coordinator();
    const shown = await shownFor(actor);
    await acceptCurrentTerms(actor, shown);
    const again = await acceptCurrentTerms(actor, shown);
    expect(again.success && again.value).toEqual({ recorded: 0 });
    expect(await rowsOf([actor.userId])).toHaveLength(1);
  });
});
