/**
 * Campaign job store contract (#579).
 *
 * Persistence port for the durable campaign async-job model: a `campaign_job`
 * row plus one `campaign_job_item` row per target item. Every campaign channel
 * (export/email/voice) shares this store. Job roll-up status is DERIVED from
 * item counts — never a stored counter — so it can't drift from the item rows.
 *
 * Consumers import only this module (`./interface`) and `./testing`; the API
 * routes resolve a concrete impl via `./index`, the worker via its own client.
 *
 * @module @aggregator-dpg/api
 */

export type CampaignChannel = 'export' | 'email' | 'voice';

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

/** Item statuses that mean the channel acted successfully on the item. */
export const SUCCESS_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'resolved',
  'submitted',
  'sent',
];

/**
 * Item statuses that are neither success nor failure — the item was
 * deliberately not acted on. Skips never make a job `partial`.
 */
export const SKIPPED_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
];

/** Item statuses an item can no longer move out of (retry-safety guard). */
export const TERMINAL_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  ...SUCCESS_ITEM_STATUSES,
  ...SKIPPED_ITEM_STATUSES,
  'failed',
];

/** Statuses that keep an item inside the active-dedup predicate. */
export const ACTIVE_DEDUP_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'pending',
  'resolved',
  'submitted',
];

/** Job statuses that count against a tenant's active-job cap. */
export const ACTIVE_JOB_STATUSES: readonly CampaignJobStatus[] = ['queued', 'processing'];

/** Job statuses a job can no longer move out of. */
export const TERMINAL_JOB_STATUSES: readonly CampaignJobStatus[] = [
  'partial',
  'completed',
  'failed',
];

/** A single free-form metadata pair; stored verbatim from the request envelope. */
export interface CampaignMetadataPair {
  key: string;
  value: string;
}

/** Item to enqueue on a job. `action` is NULL for export (no per-item action). */
export interface CreateJobItemInput {
  itemId: string;
  action: string | null;
}

export interface CreateJobInput {
  aggregatorId: string;
  signalstackOrgId: string;
  channel: CampaignChannel;
  metadata: CampaignMetadataPair[];
  content: Record<string, unknown>;
  requestedBy: string;
  requestId?: string;
  /** Request idempotency key — a replay returns the original job. */
  idempotencyKey?: string;
  items: CreateJobItemInput[];
}

/** Minimal job identity returned by {@link CampaignJobStoreBase.createJob}. */
export interface JobRecord {
  id: string;
  channel: CampaignChannel;
  status: CampaignJobStatus;
  signalstackOrgId: string;
}

/** Derived item-status tally for a job. `total` is the sum of the four buckets. */
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

export interface JobItemView {
  itemId: string;
  action: string | null;
  status: CampaignJobItemStatus;
  /** External id this item produced (voice: Raya call id; email: message id). */
  providerRef: string | null;
  /** Why the item was skipped, when `status` is one of the skip terminals. */
  skipReason: string | null;
  errorReason: string | null;
}

/** Tenant-facing projection of a job (list + detail endpoints). */
export interface JobView {
  id: string;
  channel: CampaignChannel;
  status: CampaignJobStatus;
  metadata: CampaignMetadataPair[];
  content: Record<string, unknown>;
  errorReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  counts: JobStatusCounts;
}

/** Unscoped projection the worker loads to process a job (no tenant filter — the jobId comes from the trusted queue). */
export interface ProcessingJobView {
  id: string;
  channel: CampaignChannel;
  status: CampaignJobStatus;
  signalstackOrgId: string;
  metadata: CampaignMetadataPair[];
  content: Record<string, unknown>;
  requestedBy: string;
  requestId: string | null;
  items: JobItemView[];
}

export interface ListJobsOptions {
  channel?: CampaignChannel;
  limit?: number;
  cursor?: string | null;
}

export interface ListJobsResult {
  jobs: JobView[];
  nextCursor: string | null;
}

export type StoreError =
  { code: 'NOT_FOUND'; message: string } | { code: 'DB_UNAVAILABLE'; message: string };

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

/**
 * Rolls up the terminal job status from item counts. Pure — shared by every
 * store impl so the derivation lives in exactly one place.
 *
 * @param counts - The job's item-status tally.
 * @returns `processing` while any item is still pending; otherwise `succeeded`
 *   (no failures), `failed` (no successes), or `partially_failed` (a mix). An
 *   itemless job is treated as `succeeded`.
 */
export function deriveJobStatus(counts: JobStatusCounts): CampaignJobStatus {
  if (counts.pending > 0) return 'processing';
  if (counts.total === 0) return 'completed';
  const succeeded = counts.resolved + counts.submitted + counts.sent;
  // Skips (not owned / no contact / duplicate) are deliberate no-ops, not
  // failures, so they never make a job `partial`. A job whose items were ALL
  // skipped is therefore `completed`, not `failed`: the handler ran correctly
  // and simply found nothing to act on. The caller distinguishes the two from
  // `counts` (e.g. resolved: 0, skipped_not_owned: 4), not from the status.
  if (counts.failed === 0) return 'completed';
  if (succeeded === 0) return 'failed';
  return 'partial';
}

export abstract class CampaignJobStoreBase {
  /**
   * Creates a job and its item rows in one transaction. Idempotent on
   * `idempotencyKey`: a replayed key returns the original job with
   * `created:false` (and enqueues nothing new — the caller checks the flag).
   */
  abstract createJob(
    input: CreateJobInput,
  ): Promise<StoreResult<{ job: JobRecord; created: boolean }>>;

  /** Count a tenant's active (pending|processing) jobs — for the per-org cap. */
  abstract countActiveJobs(signalstackOrgId: string): Promise<StoreResult<number>>;

  /** Tenant-scoped job detail (with derived counts); null when absent/not owned. */
  abstract getJob(jobId: string, signalstackOrgId: string): Promise<StoreResult<JobView | null>>;

  /** Tenant-scoped item list; null when the job is absent/not owned. */
  abstract getJobItems(
    jobId: string,
    signalstackOrgId: string,
  ): Promise<StoreResult<JobItemView[] | null>>;

  /** Tenant-scoped, newest-first, cursor-paginated job list. */
  abstract listJobs(
    signalstackOrgId: string,
    options: ListJobsOptions,
  ): Promise<StoreResult<ListJobsResult>>;

  /** Unscoped load for the worker (jobId is trusted — it came off the queue). */
  abstract getJobForProcessing(jobId: string): Promise<StoreResult<ProcessingJobView | null>>;

  /** Derived item-status tally for a job. */
  abstract countItems(jobId: string): Promise<StoreResult<JobStatusCounts>>;

  /**
   * Sets an item's status. Forward-only: an item already in a terminal status
   * is not overwritten (a retried job re-processes only still-pending items).
   *
   * @param reason - Free-text cause. Stored in `skip_reason` when `status` is a
   *   skip terminal, otherwise in `error_reason`.
   */
  abstract markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    reason?: string,
  ): Promise<StoreResult<void>>;

  /** Stamps `last_progress_at = now()` (watchdog heartbeat). */
  abstract heartbeat(jobId: string): Promise<StoreResult<void>>;

  /** Sets the job's roll-up status (and optional error reason). */
  abstract setJobStatus(
    jobId: string,
    status: CampaignJobStatus,
    errorReason?: string,
  ): Promise<StoreResult<void>>;

  /** Ids of `processing` jobs whose `last_progress_at` is older than the cutoff. */
  abstract claimStalledJobs(olderThanSeconds: number): Promise<StoreResult<string[]>>;

  /**
   * Derives and persists the job's roll-up status from its item counts.
   *
   * @param jobId - The job to roll up.
   * @returns The derived {@link CampaignJobStatus} that was persisted.
   */
  async rollUpStatus(jobId: string): Promise<StoreResult<CampaignJobStatus>> {
    const counts = await this.countItems(jobId);
    if (!counts.ok) return counts;
    const status = deriveJobStatus(counts.value);
    const set = await this.setJobStatus(jobId, status);
    if (!set.ok) return set;
    return { ok: true, value: status };
  }
}
