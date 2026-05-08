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
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

// ─── Job payloads ────────────────────────────────────────────────────────────

export interface BulkFileProcessJob {
  uploadId: string;
  aggregatorId: string;
  s3Key: string;
  participantType: 'seeker' | 'provider';
  schemaId: string;
  schemaVersion: string;
}

export interface BulkRowProcessJob {
  uploadId: string;
  aggregatorId: string;
  rowIndex: number;
  /** Original CSV line as captured by the File Processor. */
  rawRow: string;
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

// ─── Redis connection ────────────────────────────────────────────────────────

export interface RedisConnectionOptions {
  /** redis://host:port[/db] — full URL form. Defaults to REDIS_URL env. */
  url?: string;
}

/**
 * Returns an ioredis instance configured for BullMQ. Per BullMQ docs,
 * `maxRetriesPerRequest` MUST be `null` for queue connections.
 *
 * Caller owns the lifetime — call `.disconnect()` on shutdown.
 */
export function createRedisConnection(opts: RedisConnectionOptions = {}): Redis {
  const url = opts.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

// ─── Standard job options ────────────────────────────────────────────────────

export const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 604800 },
} as const;

// ─── Lua scripts ─────────────────────────────────────────────────────────────

export {
  runBulkRowCommit,
  bulkRowCommitScript,
  type BulkRowCommitResult,
  type BulkRowOutcome,
} from './lua-loader.js';
