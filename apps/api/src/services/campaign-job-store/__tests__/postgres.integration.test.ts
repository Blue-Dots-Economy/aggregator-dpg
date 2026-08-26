/**
 * Integration test for {@link PostgresCampaignJobStore} — runs the shared
 * conformance suite against a live Postgres (the same contract the in-memory
 * store passes).
 *
 * Skipped unless `INTEGRATION_DATABASE_URL` is set, so `pnpm -w test` (which
 * force-sets a credential-free placeholder `DATABASE_URL`) leaves it green.
 * Run it against a migrated aggregator DB with:
 *
 *   INTEGRATION_DATABASE_URL=postgres://aggregator:...@127.0.0.1:5433/aggregator \
 *     pnpm --filter @aggregator-dpg/api exec vitest run \
 *     src/services/campaign-job-store/__tests__/postgres.integration.test.ts
 *
 * @module @aggregator-dpg/api
 */
import { afterAll, beforeAll, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ConsentRecord } from '@aggregator-dpg/shared-primitives/aggregator';
import { getDb, getPool, closeDb, _setDbClients } from '../../../db/client.js';
import { aggregators, campaignJob } from '../../../db/schema.js';
import { PostgresCampaignJobStore } from '../postgres.js';
import { runStoreConformance } from './conformance.js';

// The vitest config force-sets a placeholder DATABASE_URL, so the real
// connection string is read from a separate, non-overridden env var.
const realUrl = process.env.INTEGRATION_DATABASE_URL;
const suite = realUrl ? describe : describe.skip;

let aggregatorId: string = randomUUID();

suite('PostgresCampaignJobStore (integration)', () => {
  beforeAll(async () => {
    // Rebind the shared Drizzle client to the real DB (getPool caches on the
    // real url; getDb() then builds its client against it).
    _setDbClients(null, null);
    getPool({ url: realUrl! });

    const suffix = randomUUID().slice(0, 8);
    const rows = await getDb()
      .insert(aggregators)
      .values({
        orgSlug: `cjs-test-${suffix}`,
        actorType: 'aggregator',
        name: 'Campaign Job Store Test',
        contact: {
          name: 'Test',
          phone: `+9100000${suffix.slice(0, 5)}`,
          email: `cjs-${suffix}@x.example`,
        },
        consent: {} as unknown as ConsentRecord,
        createdBy: 'integration-test',
        updatedBy: 'integration-test',
      })
      .returning({ id: aggregators.id });
    aggregatorId = rows[0]!.id;
  });

  afterAll(async () => {
    // campaign_job_item cascades on the job delete; then remove the test aggregator.
    await getDb().delete(campaignJob).where(eq(campaignJob.aggregatorId, aggregatorId));
    await getDb().delete(aggregators).where(eq(aggregators.id, aggregatorId));
    await closeDb();
  });

  runStoreConformance(() => new PostgresCampaignJobStore(), {
    get aggregatorId() {
      return aggregatorId;
    },
  } as { aggregatorId: string });
});
