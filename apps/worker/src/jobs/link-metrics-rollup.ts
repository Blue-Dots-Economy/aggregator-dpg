/**
 * Link Metrics Aggregator — periodic rollup of `link_submissions` into
 * `onboarding`.
 *
 * Per onboarding-implementation.md §4.3:
 *   1. SELECT * FROM link_submissions WHERE rolled_up_at IS NULL
 *      ORDER BY created_at LIMIT BATCH_SIZE.
 *   2. Aggregate by (aggregator_id, link_id, hour_bucket).
 *   3. UPSERT INTO onboarding (source='link', ...) ON CONFLICT
 *      (aggregator_id, link_id, period_start) WHERE source='link' DO UPDATE
 *      SET total/passed/failed/skipped += EXCLUDED.*.
 *   4. UPDATE link_submissions SET rolled_up_at = NOW() WHERE id IN (...).
 *
 * Idempotent. Restart-safe via `rolled_up_at IS NULL` filter.
 */

import { eq, inArray, isNull, sql } from 'drizzle-orm';
import type { LinkMetricsRollupJob } from '@aggregator-dpg/queue';
import { getDb, schema } from '../db.js';
import { logger } from '../logger.js';

const BATCH_SIZE = 1000;

interface BucketKey {
  aggregatorId: string;
  orgSlug: string;
  linkId: string;
  hourBucketIso: string;
}

interface BucketTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  submissionIds: string[];
}

export interface RollupOutcome {
  status: 'rolled_up' | 'idle';
  submissions: number;
  buckets: number;
}

export async function rollupLinkMetrics(_job: LinkMetricsRollupJob): Promise<RollupOutcome> {
  const log = logger.child({ operation: 'linkMetricsRollup' });
  const start = Date.now();

  const rows = await getDb()
    .select({
      id: schema.linkSubmissions.id,
      linkId: schema.linkSubmissions.linkId,
      aggregatorId: schema.linkSubmissions.aggregatorId,
      orgSlug: schema.aggregators.orgSlug,
      outcome: schema.linkSubmissions.outcome,
      createdAt: schema.linkSubmissions.createdAt,
    })
    .from(schema.linkSubmissions)
    .innerJoin(schema.aggregators, eq(schema.linkSubmissions.aggregatorId, schema.aggregators.id))
    .where(isNull(schema.linkSubmissions.rolledUpAt))
    .orderBy(schema.linkSubmissions.createdAt)
    .limit(BATCH_SIZE);

  if (rows.length === 0) {
    log.info({ status: 'idle', latency_ms: Date.now() - start });
    return { status: 'idle', submissions: 0, buckets: 0 };
  }

  // Group by (aggregator, link, hour-bucket).
  const buckets = new Map<string, { key: BucketKey; totals: BucketTotals }>();
  for (const row of rows) {
    const bucketStart = startOfHour(row.createdAt);
    const cacheKey = `${row.aggregatorId}|${row.linkId}|${bucketStart.toISOString()}`;
    let entry = buckets.get(cacheKey);
    if (!entry) {
      entry = {
        key: {
          aggregatorId: row.aggregatorId,
          orgSlug: row.orgSlug,
          linkId: row.linkId,
          hourBucketIso: bucketStart.toISOString(),
        },
        totals: { total: 0, passed: 0, failed: 0, skipped: 0, submissionIds: [] },
      };
      buckets.set(cacheKey, entry);
    }
    entry.totals.total += 1;
    if (row.outcome === 'passed') entry.totals.passed += 1;
    else if (row.outcome === 'failed') entry.totals.failed += 1;
    else if (row.outcome === 'skipped') entry.totals.skipped += 1;
    entry.totals.submissionIds.push(row.id);
  }

  // UPSERT each bucket — partial UNIQUE (aggregator_id, link_id, period_start)
  // WHERE source='link' is the conflict target.
  for (const { key, totals } of buckets.values()) {
    const periodStart = new Date(key.hourBucketIso);
    const periodEnd = new Date(periodStart.getTime() + 60 * 60 * 1000);
    await getDb()
      .insert(schema.onboarding)
      .values({
        aggregatorId: key.aggregatorId,
        orgSlug: key.orgSlug,
        source: 'link',
        batchId: null,
        linkId: key.linkId,
        periodStart,
        periodEnd,
        total: totals.total,
        passed: totals.passed,
        failed: totals.failed,
        skipped: totals.skipped,
      })
      .onConflictDoUpdate({
        target: [
          schema.onboarding.aggregatorId,
          schema.onboarding.linkId,
          schema.onboarding.periodStart,
        ],
        targetWhere: sql`source = 'link'`,
        set: {
          total: sql`${schema.onboarding.total} + ${totals.total}`,
          passed: sql`${schema.onboarding.passed} + ${totals.passed}`,
          failed: sql`${schema.onboarding.failed} + ${totals.failed}`,
          skipped: sql`${schema.onboarding.skipped} + ${totals.skipped}`,
        },
      });
  }

  // Mark all picked-up submissions as rolled up.
  const allIds = rows.map((r) => r.id);
  await getDb()
    .update(schema.linkSubmissions)
    .set({ rolledUpAt: new Date() })
    .where(inArray(schema.linkSubmissions.id, allIds));

  log.info({
    status: 'success',
    latency_ms: Date.now() - start,
    submissions: rows.length,
    buckets: buckets.size,
  });
  return { status: 'rolled_up', submissions: rows.length, buckets: buckets.size };
}

function startOfHour(d: Date): Date {
  const out = new Date(d);
  out.setUTCMinutes(0, 0, 0);
  return out;
}
