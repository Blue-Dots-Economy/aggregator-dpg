/**
 * Row counters of a bulk upload, read from Redis while it runs and from the
 * `onboarding` row once finalised. Belongs to `@aggregator-dpg/api`.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { onboarding } from '../../db/schema.js';
import { getRedis } from '../redis/index.js';

/** Row counters of one upload. */
export interface UploadCounts {
  totalRows: number | null;
  passed: number;
  failed: number;
  skipped: number;
}

export const ZERO_COUNTS: UploadCounts = { totalRows: null, passed: 0, failed: 0, skipped: 0 };

/**
 * Loads live counters from Redis for an in-flight upload.
 *
 * Returns ZERO_COUNTS when the keys are missing.
 */
async function loadCountsFromRedis(uploadId: string): Promise<UploadCounts> {
  try {
    const redis = getRedis();
    const ns = `bu:${uploadId}`;
    const [counters, meta] = await Promise.all([
      redis.hmget(`${ns}:counters`, 'passed', 'failed', 'skipped'),
      redis.hget(`${ns}:meta`, 'total_rows'),
    ]);
    const passed = Number.parseInt(counters[0] ?? '0', 10) || 0;
    const failed = Number.parseInt(counters[1] ?? '0', 10) || 0;
    const skipped = Number.parseInt(counters[2] ?? '0', 10) || 0;
    const totalRows = meta ? Number.parseInt(meta, 10) || null : null;
    return { totalRows, passed, failed, skipped };
  } catch {
    return ZERO_COUNTS;
  }
}

/**
 * Loads final counters from the `onboarding` row written by `bulk-finalise`.
 *
 * Returns ZERO_COUNTS when the row is missing.
 */
async function loadCountsFromOnboarding(uploadId: string): Promise<UploadCounts> {
  const rows = await getDb()
    .select({
      total: onboarding.total,
      passed: onboarding.passed,
      failed: onboarding.failed,
      skipped: onboarding.skipped,
    })
    .from(onboarding)
    .where(and(eq(onboarding.source, 'bulk'), eq(onboarding.batchId, uploadId)))
    .limit(1);
  const row = rows[0];
  if (!row) return ZERO_COUNTS;
  return {
    totalRows: row.total,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
  };
}

/** Replaces {@link loadCounts} in tests; `null` reads Redis and the database. */
let countsOverride: ((uploadId: string, status: string) => Promise<UploadCounts>) | null = null;

/** Test helper — replace {@link loadCounts} with `fn`; `null` restores it. */
export function _setCountsLoader(
  fn: ((uploadId: string, status: string) => Promise<UploadCounts>) | null,
): void {
  countsOverride = fn;
}

/** Picks the right counter source based on upload status. */
export async function loadCounts(uploadId: string, status: string): Promise<UploadCounts> {
  if (countsOverride) return countsOverride(uploadId, status);
  if (status === 'completed') return loadCountsFromOnboarding(uploadId);
  if (status === 'pending' || status === 'uploaded') return ZERO_COUNTS;
  return loadCountsFromRedis(uploadId);
}

/** Batch counter load for list view — one onboarding query, Redis fan-out for active rows. */
export async function loadCountsBatch(
  uploads: Array<{ id: string; status: string }>,
): Promise<Map<string, UploadCounts>> {
  const out = new Map<string, UploadCounts>();
  const completedIds = uploads.filter((u) => u.status === 'completed').map((u) => u.id);
  if (completedIds.length > 0) {
    const rows = await getDb()
      .select({
        batchId: onboarding.batchId,
        total: onboarding.total,
        passed: onboarding.passed,
        failed: onboarding.failed,
        skipped: onboarding.skipped,
      })
      .from(onboarding)
      .where(and(eq(onboarding.source, 'bulk'), inArray(onboarding.batchId, completedIds)));
    for (const r of rows) {
      if (!r.batchId) continue;
      out.set(r.batchId, {
        totalRows: r.total,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      });
    }
  }
  const liveUploads = uploads.filter(
    (u) => u.status !== 'completed' && u.status !== 'pending' && u.status !== 'uploaded',
  );
  for (const u of liveUploads) {
    out.set(u.id, await loadCountsFromRedis(u.id));
  }
  return out;
}
