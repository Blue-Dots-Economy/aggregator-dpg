/**
 * Integration test for the local-dev seed script.
 *
 * Verifies that runSeed() is idempotent — two invocations leave the DB in
 * the same state as one. Skipped when DATABASE_URL is not set.
 *
 * Run: DATABASE_URL=postgres://... pnpm --filter @aggregator-dpg/db test:integration
 *
 * @module @aggregator-dpg/db/__tests__
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import { runSeed, SEED_IDS } from '../../scripts/seed.js';

const dbUrl = process.env['DATABASE_URL'];
const suite = dbUrl ? describe : describe.skip;

const silentLog = { log: () => {}, error: () => {} };

suite('runSeed (integration) — idempotency', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl! });
    db = drizzle(pool, { schema });
    // Ensure a clean slate — any prior manual or test-run seed is removed
    // before the suite begins so "first run inserts" expectations hold.
    await db
      .delete(schema.onboardingLink)
      .where(eq(schema.onboardingLink.id, SEED_IDS.onboardingLink1));
    await db
      .delete(schema.onboardingLink)
      .where(eq(schema.onboardingLink.id, SEED_IDS.onboardingLink2));
    await db
      .delete(schema.aggregatorProfile)
      .where(eq(schema.aggregatorProfile.aggregatorId, SEED_IDS.aggregator));
    await db
      .delete(schema.aggregatorProfileSchema)
      .where(eq(schema.aggregatorProfileSchema.id, SEED_IDS.schemaVersion));
  });

  afterAll(async () => {
    // Cleanup: remove the deterministic seed rows so other tests start clean.
    await db
      .delete(schema.onboardingLink)
      .where(eq(schema.onboardingLink.id, SEED_IDS.onboardingLink1));
    await db
      .delete(schema.onboardingLink)
      .where(eq(schema.onboardingLink.id, SEED_IDS.onboardingLink2));
    await db
      .delete(schema.aggregatorProfile)
      .where(eq(schema.aggregatorProfile.aggregatorId, SEED_IDS.aggregator));
    await db
      .delete(schema.aggregatorProfileSchema)
      .where(eq(schema.aggregatorProfileSchema.id, SEED_IDS.schemaVersion));
    await pool.end();
  });

  it('first run inserts all sample rows', async () => {
    const result = await runSeed(db, silentLog);
    expect(result.schemaVersion.inserted).toBe(true);
    expect(result.aggregator.inserted).toBe(true);
    expect(result.onboardingLinks.every((l) => l.inserted)).toBe(true);
  });

  it('second run inserts nothing (idempotent)', async () => {
    const result = await runSeed(db, silentLog);
    expect(result.schemaVersion.inserted).toBe(false);
    expect(result.aggregator.inserted).toBe(false);
    expect(result.onboardingLinks.every((l) => !l.inserted)).toBe(true);
  });

  it('row counts for seeded ids remain exactly 1 after repeated runs', async () => {
    await runSeed(db, silentLog);
    await runSeed(db, silentLog);

    const schemas = await db
      .select()
      .from(schema.aggregatorProfileSchema)
      .where(eq(schema.aggregatorProfileSchema.id, SEED_IDS.schemaVersion));
    const aggs = await db
      .select()
      .from(schema.aggregatorProfile)
      .where(eq(schema.aggregatorProfile.aggregatorId, SEED_IDS.aggregator));
    const link1 = await db
      .select()
      .from(schema.onboardingLink)
      .where(eq(schema.onboardingLink.id, SEED_IDS.onboardingLink1));
    const link2 = await db
      .select()
      .from(schema.onboardingLink)
      .where(eq(schema.onboardingLink.id, SEED_IDS.onboardingLink2));

    expect(schemas).toHaveLength(1);
    expect(aggs).toHaveLength(1);
    expect(link1).toHaveLength(1);
    expect(link2).toHaveLength(1);
  });

  it('seeded schema version is active = true', async () => {
    const [row] = await db
      .select()
      .from(schema.aggregatorProfileSchema)
      .where(eq(schema.aggregatorProfileSchema.id, SEED_IDS.schemaVersion));
    expect(row?.active).toBe(true);
  });
});
