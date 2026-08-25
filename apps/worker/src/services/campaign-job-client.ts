/**
 * Worker-side persistence for the campaign job model (#579).
 *
 * The API owns job creation; the worker only reads a job for processing and
 * writes item + job status back. This is a thin Drizzle client against the same
 * `campaign_job` / `campaign_job_item` tables (shared via `@aggregator-dpg/db-schema`)
 * — the cross-app twin of the API's `campaign-job-store`. Kept separate rather
 * than imported to respect the app boundary (the dependency-cruiser forbids
 * apps importing each other); the small `deriveJobStatus` roll-up rule is
 * duplicated for the same reason and must stay in step with the API's copy.
 *
 * @module @aggregator-dpg/worker
 */
import { and, count, eq, lt, sql } from 'drizzle-orm';
import {
  campaignJob,
  campaignJobItem,
  type CampaignMetadataPair,
} from '@aggregator-dpg/db-schema/schema';
import { getDb } from '../db.js';

export type CampaignJobStatus = 'queued' | 'processing' | 'partial' | 'completed' | 'failed';
export type CampaignJobItemStatus =
  | 'pending'
  | 'resolved'
  | 'submitted'
  | 'sent'
  | 'skipped_not_owned'
  | 'skipped_no_contact'
  | 'duplicate_active'
  | 'failed';

/** Item statuses that are deliberate no-ops rather than failures. */
export const SKIPPED_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
];

/** Item statuses an item can no longer move out of (retry-safety guard). */
export const TERMINAL_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'resolved',
  'submitted',
  'sent',
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
  'failed',
];

/** Job statuses a job can no longer move out of. */
export const TERMINAL_JOB_STATUSES: readonly CampaignJobStatus[] = [
  'partial',
  'completed',
  'failed',
];
export type CampaignChannel = 'export' | 'email' | 'voice';

export interface ProcessingJobItem {
  itemId: string;
  action: string | null;
  status: CampaignJobItemStatus;
}

export interface ProcessingJob {
  id: string;
  channel: CampaignChannel;
  status: CampaignJobStatus;
  signalstackOrgId: string;
  metadata: CampaignMetadataPair[];
  content: Record<string, unknown>;
  requestedBy: string;
  requestId: string | null;
  items: ProcessingJobItem[];
}

export interface JobStatusCounts {
  total: number;
  pending: number;
  resolved: number;
  submitted: number;
  sent: number;
  skipped_not_owned: number;
  skipped_no_contact: number;
  duplicate_active: number;
  failed: number;
}

/**
 * Derives the roll-up job status from item counts. Duplicate of the API's
 * `deriveJobStatus` (see module note) — keep the two in step.
 *
 * @param c - The job's item-status tally.
 * @returns The derived job status.
 */
export function deriveJobStatus(c: JobStatusCounts): CampaignJobStatus {
  if (c.pending > 0) return 'processing';
  if (c.total === 0) return 'completed';
  const succeeded = c.resolved + c.submitted + c.sent;
  // Skips are deliberate no-ops, never failures — see the API-side twin.
  if (c.failed === 0) return 'completed';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

/** Loads a job + its items for processing (unscoped — the jobId is trusted). */
export async function getJobForProcessing(jobId: string): Promise<ProcessingJob | null> {
  const rows = await getDb().select().from(campaignJob).where(eq(campaignJob.id, jobId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const items = await getDb()
    .select()
    .from(campaignJobItem)
    .where(eq(campaignJobItem.jobId, jobId))
    .orderBy(campaignJobItem.createdAt);
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    signalstackOrgId: row.signalstackOrgId,
    metadata: row.metadata,
    content: row.content,
    requestedBy: row.requestedBy,
    requestId: row.requestId,
    items: items.map((i) => ({ itemId: i.itemId, action: i.action, status: i.status })),
  };
}

/** Item-status tally for a job (derived, never a stored counter). */
export async function countItems(jobId: string): Promise<JobStatusCounts> {
  const rows = await getDb()
    .select({ status: campaignJobItem.status, n: count() })
    .from(campaignJobItem)
    .where(eq(campaignJobItem.jobId, jobId))
    .groupBy(campaignJobItem.status);
  const counts: JobStatusCounts = {
    total: 0,
    pending: 0,
    resolved: 0,
    submitted: 0,
    sent: 0,
    skipped_not_owned: 0,
    skipped_no_contact: 0,
    duplicate_active: 0,
    failed: 0,
  };
  for (const r of rows) {
    const n = Number(r.n);
    counts[r.status] += n;
    counts.total += n;
  }
  return counts;
}

/**
 * Forward-only item status write — a terminal item is not overwritten.
 *
 * @param providerRef - External id this item produced (email: the mailer's
 *   message id; voice: the Raya call id). Left untouched when omitted.
 */
export async function markItem(
  jobId: string,
  itemId: string,
  status: CampaignJobItemStatus,
  reason?: string,
  providerRef?: string,
): Promise<void> {
  await getDb()
    .update(campaignJobItem)
    .set({
      status,
      // A skip is not an error: its reason belongs in `skip_reason`.
      skipReason: SKIPPED_ITEM_STATUSES.includes(status) ? (reason ?? null) : null,
      errorReason: SKIPPED_ITEM_STATUSES.includes(status) ? null : (reason ?? null),
      ...(providerRef !== undefined ? { providerRef } : {}),
      updatedAt: new Date(),
      ...(TERMINAL_ITEM_STATUSES.includes(status) ? { completedAt: new Date() } : {}),
    })
    .where(
      and(
        eq(campaignJobItem.jobId, jobId),
        eq(campaignJobItem.itemId, itemId),
        sql`${campaignJobItem.status} NOT IN ('resolved','submitted','sent','skipped_not_owned','skipped_no_contact','duplicate_active','failed')`,
      ),
    );
}

/** Stamps `last_progress_at = now()` (watchdog heartbeat). */
export async function heartbeat(jobId: string): Promise<void> {
  await getDb()
    .update(campaignJob)
    .set({ lastProgressAt: new Date() })
    .where(eq(campaignJob.id, jobId));
}

/** Sets the job's roll-up status (+ optional error reason). */
export async function setJobStatus(
  jobId: string,
  status: CampaignJobStatus,
  errorReason?: string,
): Promise<void> {
  await getDb()
    .update(campaignJob)
    .set({
      status,
      ...(errorReason !== undefined ? { errorReason } : {}),
      updatedAt: new Date(),
      ...(TERMINAL_JOB_STATUSES.includes(status) ? { completedAt: new Date() } : {}),
    })
    .where(eq(campaignJob.id, jobId));
}

/** Derives + persists the job's roll-up status from its item counts. */
export async function rollUpStatus(jobId: string): Promise<CampaignJobStatus> {
  const status = deriveJobStatus(await countItems(jobId));
  await setJobStatus(jobId, status);
  return status;
}

/** Ids of `processing` jobs whose `last_progress_at` is older than the cutoff. */
export async function claimStalledJobs(olderThanSeconds: number): Promise<string[]> {
  const rows = await getDb()
    .select({ id: campaignJob.id })
    .from(campaignJob)
    .where(
      and(
        eq(campaignJob.status, 'processing'),
        lt(campaignJob.lastProgressAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
      ),
    );
  return rows.map((r) => r.id);
}
