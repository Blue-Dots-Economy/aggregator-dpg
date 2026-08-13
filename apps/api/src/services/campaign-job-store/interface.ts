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

export type CampaignJobStatus =
  'pending' | 'processing' | 'succeeded' | 'partially_failed' | 'failed';

export type CampaignJobItemStatus = 'pending' | 'resolved' | 'submitted' | 'failed';

/** In-flight/success item statuses — everything that isn't a hard failure. */
export const NON_FAILED_ITEM_STATUSES: readonly CampaignJobItemStatus[] = [
  'pending',
  'resolved',
  'submitted',
];

/** Job statuses that count against a tenant's active-job cap. */
export const ACTIVE_JOB_STATUSES: readonly CampaignJobStatus[] = ['pending', 'processing'];

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
  failed: number;
}

export interface JobItemView {
  itemId: string;
  action: string | null;
  status: CampaignJobItemStatus;
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
  if (counts.total === 0) return 'succeeded';
  const succeeded = counts.resolved + counts.submitted;
  if (counts.failed === 0) return 'succeeded';
  if (succeeded === 0) return 'failed';
  return 'partially_failed';
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
   * (resolved|submitted|failed) is not overwritten (a retried job re-processes
   * only still-pending items).
   */
  abstract markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    errorReason?: string,
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
