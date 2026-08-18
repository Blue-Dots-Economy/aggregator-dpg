/**
 * Postgres adapter for the campaign job store.
 *
 * Wraps Drizzle queries against `campaign_job` / `campaign_job_item`. Job
 * creation is transactional (job + all item rows commit together); job status
 * roll-up counts are DERIVED with `COUNT(*) ... GROUP BY status` so they can't
 * drift. All errors map to the abstract `StoreError` codes.
 *
 * @module @aggregator-dpg/api
 */
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { campaignJob, campaignJobItem } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  ACTIVE_JOB_STATUSES,
  CampaignJobStoreBase,
  type CampaignJobItemStatus,
  type CampaignJobStatus,
  type CreateJobInput,
  type JobItemView,
  type JobRecord,
  type JobStatusCounts,
  type JobView,
  type ListJobsOptions,
  type ListJobsResult,
  type ProcessingJobView,
  type StoreError,
  type StoreResult,
} from './interface.js';

const CURSOR_SEP = '__';

type JobRow = typeof campaignJob.$inferSelect;

export class PostgresCampaignJobStore extends CampaignJobStoreBase {
  async createJob(
    input: CreateJobInput,
  ): Promise<StoreResult<{ job: JobRecord; created: boolean }>> {
    const start = Date.now();
    try {
      const result = await getDb().transaction(async (tx) => {
        const values = {
          aggregatorId: input.aggregatorId,
          signalstackOrgId: input.signalstackOrgId,
          channel: input.channel,
          metadata: input.metadata,
          content: input.content,
          requestedBy: input.requestedBy,
          requestId: input.requestId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        };
        const insertedRows = input.idempotencyKey
          ? await tx
              .insert(campaignJob)
              .values(values)
              .onConflictDoNothing({
                target: campaignJob.idempotencyKey,
                where: sql`idempotency_key IS NOT NULL`,
              })
              .returning()
          : await tx.insert(campaignJob).values(values).returning();

        let row = insertedRows[0];
        let created = true;
        if (!row) {
          // Idempotency-key conflict — return the original job, add no items.
          created = false;
          const existing = await tx
            .select()
            .from(campaignJob)
            .where(eq(campaignJob.idempotencyKey, input.idempotencyKey!))
            .limit(1);
          row = existing[0];
        }
        if (!row) throw new Error('campaign job insert returned no row');

        if (created && input.items.length > 0) {
          await tx.insert(campaignJobItem).values(
            input.items.map((i) => ({
              jobId: row!.id,
              itemId: i.itemId,
              action: i.action,
            })),
          );
        }
        return { row, created };
      });

      logger.info({
        operation: 'campaignJobStore.createJob',
        status: 'success',
        latency_ms: Date.now() - start,
        job_id: result.row.id,
        channel: result.row.channel,
        created: result.created,
        items: input.items.length,
      });
      return { ok: true, value: { job: toRecord(result.row), created: result.created } };
    } catch (err) {
      return dbError('createJob', err, start);
    }
  }

  async countActiveJobs(signalstackOrgId: string): Promise<StoreResult<number>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select({ n: count() })
        .from(campaignJob)
        .where(
          and(
            eq(campaignJob.signalstackOrgId, signalstackOrgId),
            inArray(campaignJob.status, [...ACTIVE_JOB_STATUSES]),
          ),
        );
      return { ok: true, value: Number(rows[0]?.n ?? 0) };
    } catch (err) {
      return dbError('countActiveJobs', err, start);
    }
  }

  async getJob(jobId: string, signalstackOrgId: string): Promise<StoreResult<JobView | null>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select()
        .from(campaignJob)
        .where(and(eq(campaignJob.id, jobId), eq(campaignJob.signalstackOrgId, signalstackOrgId)))
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      const counts = await this.countItems(jobId);
      if (!counts.ok) return counts;
      return { ok: true, value: toView(row, counts.value) };
    } catch (err) {
      return dbError('getJob', err, start);
    }
  }

  async getJobItems(
    jobId: string,
    signalstackOrgId: string,
  ): Promise<StoreResult<JobItemView[] | null>> {
    const start = Date.now();
    try {
      const owner = await getDb()
        .select({ id: campaignJob.id })
        .from(campaignJob)
        .where(and(eq(campaignJob.id, jobId), eq(campaignJob.signalstackOrgId, signalstackOrgId)))
        .limit(1);
      if (!owner[0]) return { ok: true, value: null };
      const rows = await getDb()
        .select()
        .from(campaignJobItem)
        .where(eq(campaignJobItem.jobId, jobId))
        .orderBy(campaignJobItem.createdAt);
      return { ok: true, value: rows.map(toItemView) };
    } catch (err) {
      return dbError('getJobItems', err, start);
    }
  }

  async listJobs(
    signalstackOrgId: string,
    options: ListJobsOptions,
  ): Promise<StoreResult<ListJobsResult>> {
    const start = Date.now();
    const limit = options.limit ?? 20;
    try {
      const conds = [eq(campaignJob.signalstackOrgId, signalstackOrgId)];
      if (options.channel) conds.push(eq(campaignJob.channel, options.channel));
      const cursor = options.cursor ? decodeCursor(options.cursor) : null;
      if (cursor) {
        conds.push(
          sql`(${campaignJob.createdAt}, ${campaignJob.id}) < (${cursor.ts}, ${cursor.id})`,
        );
      }
      const rows = await getDb()
        .select()
        .from(campaignJob)
        .where(and(...conds))
        .orderBy(desc(campaignJob.createdAt), desc(campaignJob.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const countsByJob = await this.countsForJobs(page.map((r) => r.id));
      const jobs = page.map((r) => toView(r, countsByJob.get(r.id) ?? emptyCounts()));
      const last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
      return { ok: true, value: { jobs, nextCursor } };
    } catch (err) {
      return dbError('listJobs', err, start);
    }
  }

  async getJobForProcessing(jobId: string): Promise<StoreResult<ProcessingJobView | null>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select()
        .from(campaignJob)
        .where(eq(campaignJob.id, jobId))
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true, value: null };
      const items = await getDb()
        .select()
        .from(campaignJobItem)
        .where(eq(campaignJobItem.jobId, jobId))
        .orderBy(campaignJobItem.createdAt);
      return {
        ok: true,
        value: {
          id: row.id,
          channel: row.channel,
          status: row.status,
          signalstackOrgId: row.signalstackOrgId,
          metadata: row.metadata,
          content: row.content,
          requestedBy: row.requestedBy,
          requestId: row.requestId,
          items: items.map(toItemView),
        },
      };
    } catch (err) {
      return dbError('getJobForProcessing', err, start);
    }
  }

  async countItems(jobId: string): Promise<StoreResult<JobStatusCounts>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select({ status: campaignJobItem.status, n: count() })
        .from(campaignJobItem)
        .where(eq(campaignJobItem.jobId, jobId))
        .groupBy(campaignJobItem.status);
      const counts = emptyCounts();
      for (const r of rows) {
        const n = Number(r.n);
        counts[r.status] += n;
        counts.total += n;
      }
      return { ok: true, value: counts };
    } catch (err) {
      return dbError('countItems', err, start);
    }
  }

  async markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    errorReason?: string,
  ): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      await getDb()
        .update(campaignJobItem)
        .set({ status, errorReason: errorReason ?? null, updatedAt: new Date() })
        .where(
          and(
            eq(campaignJobItem.jobId, jobId),
            eq(campaignJobItem.itemId, itemId),
            // Forward-only: skip rows already in a terminal status.
            sql`${campaignJobItem.status} NOT IN ('resolved','submitted','failed')`,
          ),
        );
      return { ok: true, value: undefined };
    } catch (err) {
      return dbError('markItem', err, start);
    }
  }

  async heartbeat(jobId: string): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      await getDb()
        .update(campaignJob)
        .set({ lastProgressAt: new Date() })
        .where(eq(campaignJob.id, jobId));
      return { ok: true, value: undefined };
    } catch (err) {
      return dbError('heartbeat', err, start);
    }
  }

  async setJobStatus(
    jobId: string,
    status: CampaignJobStatus,
    errorReason?: string,
  ): Promise<StoreResult<void>> {
    const start = Date.now();
    try {
      await getDb()
        .update(campaignJob)
        .set({
          status,
          ...(errorReason !== undefined ? { errorReason } : {}),
          updatedAt: new Date(),
        })
        .where(eq(campaignJob.id, jobId));
      return { ok: true, value: undefined };
    } catch (err) {
      return dbError('setJobStatus', err, start);
    }
  }

  async claimStalledJobs(olderThanSeconds: number): Promise<StoreResult<string[]>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .select({ id: campaignJob.id })
        .from(campaignJob)
        .where(
          and(
            eq(campaignJob.status, 'processing'),
            lt(campaignJob.lastProgressAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
          ),
        );
      return { ok: true, value: rows.map((r) => r.id) };
    } catch (err) {
      return dbError('claimStalledJobs', err, start);
    }
  }

  /** Grouped item-status counts for a set of jobs (one query, no N+1). */
  private async countsForJobs(jobIds: string[]): Promise<Map<string, JobStatusCounts>> {
    const out = new Map<string, JobStatusCounts>();
    if (jobIds.length === 0) return out;
    const rows = await getDb()
      .select({ jobId: campaignJobItem.jobId, status: campaignJobItem.status, n: count() })
      .from(campaignJobItem)
      .where(inArray(campaignJobItem.jobId, jobIds))
      .groupBy(campaignJobItem.jobId, campaignJobItem.status);
    for (const r of rows) {
      const c = out.get(r.jobId) ?? emptyCounts();
      const n = Number(r.n);
      c[r.status] += n;
      c.total += n;
      out.set(r.jobId, c);
    }
    return out;
  }
}

function emptyCounts(): JobStatusCounts {
  return { total: 0, pending: 0, resolved: 0, submitted: 0, failed: 0 };
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    signalstackOrgId: row.signalstackOrgId,
  };
}

function toView(row: JobRow, counts: JobStatusCounts): JobView {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    metadata: row.metadata,
    content: row.content,
    errorReason: row.errorReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    counts,
  };
}

function toItemView(row: typeof campaignJobItem.$inferSelect): JobItemView {
  return {
    itemId: row.itemId,
    action: row.action,
    status: row.status,
    errorReason: row.errorReason,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}${CURSOR_SEP}${id}`;
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  const idx = cursor.indexOf(CURSOR_SEP);
  if (idx < 0) return null;
  return { ts: cursor.slice(0, idx), id: cursor.slice(idx + CURSOR_SEP.length) };
}

function dbError(op: string, err: unknown, start: number): { ok: false; error: StoreError } {
  logger.error({
    operation: `campaignJobStore.${op}`,
    status: 'failure',
    latency_ms: Date.now() - start,
    error: err instanceof Error ? err.message : String(err),
    error_type: err instanceof Error ? err.constructor.name : 'unknown',
  });
  return {
    ok: false,
    error: { code: 'DB_UNAVAILABLE', message: `campaign job store ${op} failed` },
  };
}
