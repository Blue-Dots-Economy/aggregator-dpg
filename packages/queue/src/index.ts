/**
 * Queue surface for the bulk-upload + onboarding pipeline.
 *
 * Exposes:
 *   - QueueName constants (one per queue defined in the implementation
 *     design § BullMQ Queues).
 *   - Job payload type definitions, shared between enqueuer (API) and
 *     consumer (worker).
 *   - Connection factory that returns an ioredis client from REDIS_URL.
 *
 * BullMQ is intentionally not abstracted further — both API and worker
 * import this package and construct their own `Queue` / `Worker` instances
 * directly using these names + types.
 */

import { Redis } from 'ioredis';

// ─── Queue names ─────────────────────────────────────────────────────────────

export const QueueName = {
  /** File-level checks: download CSV, header validation, encoding, row count. */
  BulkFileProcess: 'bulk-file-process',
  /** Per-row processing: schema validate, dedup, INSERT participant. */
  BulkRowProcess: 'bulk-row-process',
  /** Run summary: stream errors.csv, UPDATE bulk_uploads, INSERT onboarding. */
  BulkFinalise: 'bulk-finalise',
  /** Periodic rollup of link_submission rows into onboarding. */
  LinkMetricsRollup: 'link-metrics-rollup',
  /** Hourly watchdog + retention sweep. */
  CronWatchdog: 'cron-watchdog',
  /** Async participant campaign email: decrypt → render → send (aggregator-dpg#578). */
  CampaignEmail: 'campaign-email',
  /**
   * Unified campaign async-job pipeline (aggregator-dpg#579). One job per
   * `campaign_job` row; the worker's `campaign` role loads the job + its items,
   * runs the per-channel handler (export/email/voice), and writes item + job
   * status back.
   */
  CampaignProcess: 'campaign-process',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

// ─── Job payloads ────────────────────────────────────────────────────────────

export interface BulkFileProcessJob {
  uploadId: string;
  aggregatorId: string;
  s3Key: string;
  participantType: string;
  schemaId: string;
  schemaVersion: string;
}

export interface BulkRowProcessJob {
  uploadId: string;
  aggregatorId: string;
  rowIndex: number;
  /** Pinned schema id, propagated from File Processor so Row Processor avoids a per-row DB read. */
  schemaId: string;
  /** Pinned schema version, propagated from File Processor. */
  schemaVersion: string;
  /** Pinned participant type, propagated from File Processor. */
  participantType: string;
  /** Parsed payload after CSV → object conversion. */
  payload: Record<string, unknown>;
}

export interface BulkFinaliseJob {
  uploadId: string;
}

export interface LinkMetricsRollupJob {
  /** Tick timestamp (epoch ms) used as part of the jobId for dedupe. */
  tick: number;
}

export interface CronWatchdogJob {
  tick: number;
}

/**
 * Unified campaign-process job (aggregator-dpg#579). Carries only the durable
 * `campaign_job` id — the worker loads the job, its items, channel, metadata,
 * and content from Postgres. All request detail lives in the row, so the queue
 * payload stays minimal and a replayed/retried job re-reads the source of truth.
 */
export interface CampaignProcessJob {
  /** `campaign_job.id` — the durable job to process. */
  jobId: string;
}

/**
 * Participant campaign email job (aggregator-dpg#578). Enqueued by the API's
 * `POST /v1/campaign/email` handler and consumed by the worker's `email` role,
 * which decrypts the owned participants, renders the Markdown template per
 * recipient (substituting placeholders), and sends via the aggregator mailer.
 * Runs send-once (see {@link EMAIL_JOB_OPTS}) so a retry never duplicates emails.
 */
export interface CampaignEmailJob {
  /** Signals org id (from the caller token's `signalstack_org_id` claim); scopes decrypt ownership. */
  orgId: string;
  /** Participant profile item ids to email. Validated (uuid, 1..EMAIL_MAX_RECIPIENTS) at the API. */
  itemIds: string[];
  /** Subject template; may contain `{{placeholder}}` tokens. */
  subject: string;
  /** Markdown body template; may contain `{{placeholder}}` tokens. */
  bodyMarkdown: string;
  /** Optional Reply-To header for the sent emails. */
  replyTo?: string;
  /** Optional free-text purpose, recorded for audit (never emailed). */
  purpose?: string;
  /** Inbound `x-request-id`, forwarded to Signals decrypt for cross-service tracing. */
  requestId?: string;
}

// ─── Redis connection ────────────────────────────────────────────────────────

export interface RedisConnectionOptions {
  /** redis://host:port[/db] — full URL form. Defaults to REDIS_URL env. */
  url?: string;
  /**
   * Per-request retry cap. Defaults to `null` (required for BullMQ queue
   * connections). Non-queue callers (e.g. the API rate limiter) should set a
   * finite value so a Redis outage fails fast instead of queueing forever.
   */
  maxRetriesPerRequest?: number | null;
  /**
   * Per-command timeout in ms. Unset for queue connections (BullMQ manages
   * its own). Set by callers that must bound a single command so a downed
   * Redis surfaces an error promptly rather than hanging the request.
   */
  commandTimeout?: number;
  /**
   * When `false`, commands issued while disconnected reject immediately
   * instead of buffering. Non-queue callers that fail open on Redis errors
   * should disable it so an outage never blocks the request path.
   */
  enableOfflineQueue?: boolean;
}

/**
 * Returns an ioredis instance. Defaults are configured for BullMQ (per its
 * docs, `maxRetriesPerRequest` MUST be `null` for queue connections); pass
 * overrides for non-queue callers that need fail-fast semantics.
 *
 * Caller owns the lifetime — call `.disconnect()` on shutdown.
 */
export function createRedisConnection(opts: RedisConnectionOptions = {}): Redis {
  const url = opts.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  return new Redis(url, {
    maxRetriesPerRequest: opts.maxRetriesPerRequest ?? null,
    enableReadyCheck: true,
    ...(opts.commandTimeout !== undefined ? { commandTimeout: opts.commandTimeout } : {}),
    ...(opts.enableOfflineQueue !== undefined
      ? { enableOfflineQueue: opts.enableOfflineQueue }
      : {}),
  });
}

// ─── Standard job options ────────────────────────────────────────────────────

export const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 604800 },
} as const;

/**
 * Send-once job options for the campaign email queue (aggregator-dpg#578).
 *
 * `attempts: 1` — the email send does NOT retry as a whole, because re-running
 * the job would re-send to recipients who already received the email. A
 * transient per-recipient failure is recorded rather than retried, guaranteeing
 * no duplicate emails.
 */
export const EMAIL_JOB_OPTS = {
  attempts: 1,
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 604800 },
} as const;

/**
 * Job options for the unified `campaign-process` queue. Same retry posture as
 * {@link DEFAULT_JOB_OPTS} (3× exponential); the API may override `attempts`
 * from `CAMPAIGN_EXPORT_ATTEMPTS` at enqueue time. Kept as a plain object (not
 * `as const`) so callers can spread an `attempts` override.
 */
export const CAMPAIGN_PROCESS_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 604800 },
};

// ─── Bulk-upload Redis key namespace ─────────────────────────────────────────

/**
 * Every per-upload Redis key under the `bu:{uploadId}:*` namespace used by the
 * bulk pipeline. Some of these hold participant PII (`:lines` = raw CSV rows,
 * `:errors` = per-row error detail incl. the raw row), so this is the single
 * list to DEL on cleanup / terminal states — keeping the File Processor,
 * Finaliser, and watchdog from drifting apart.
 *
 * @param uploadId - bulk_uploads.id.
 * @returns The six fully-qualified Redis keys for this upload.
 */
export function bulkRedisKeys(uploadId: string): string[] {
  const ns = `bu:${uploadId}`;
  return [
    `${ns}:processed`,
    `${ns}:counters`,
    `${ns}:errors`,
    `${ns}:error_rows`,
    `${ns}:meta`,
    `${ns}:lines`,
  ];
}

// ─── Lua scripts ─────────────────────────────────────────────────────────────

export {
  runBulkRowCommit,
  bulkRowCommitScript,
  type BulkRowCommitResult,
  type BulkRowOutcome,
} from './lua-loader.js';
