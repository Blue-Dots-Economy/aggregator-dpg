/**
 * Stuck-job watchdog (slice 23) and retention sweeper (slice 22).
 *
 * Runs hourly. Two passes:
 *   - watchdog: pending > 24h → failed:upload_abandoned;
 *               in-flight > 30 min stalled → failed:processing_stuck.
 *   - retention: bulk_uploads + link_submissions older than RETENTION_DAYS
 *               are deleted. Onboarding rollups are retained forever per
 *               design — no sweep there.
 *
 * S3 lifecycle (raw CSVs + errors.csv) is configured externally on the
 * bucket; the worker does not delete S3 objects.
 *
 * The campaign-stall sweep additionally force-fails any item still `pending`
 * on the job it just stalled, then writes a `completed` PII-audit row for it
 * (#617 follow-up) — see {@link auditStalledJob}. A stalled job's leftover
 * items therefore read `failed`, not `pending`, on
 * `GET /v1/campaign/{channel}/{id}` — intended: the worker that would have
 * finished them is dead, so `pending` there would be permanently misleading.
 */

import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { bulkRedisKeys } from '@aggregator-dpg/queue';
import { getDb, schema } from '../db.js';
import { getRedis } from '../services/redis.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  countItems,
  failPendingItems,
  toAuditCounts,
  type CampaignChannel,
} from '../services/campaign-job-client.js';
import {
  getCampaignAuditWriter,
  safeAudit,
  type SafeAuditLogger,
} from '../services/campaign-audit.js';
import { exportAuditExtras } from '../services/campaign-process/index.js';

const RETENTION_DAYS = 90;
const STUCK_INFLIGHT_MINUTES = 30;
const ABANDONED_PENDING_HOURS = 24;
const INFLIGHT_STATUSES = ['file_validating', 'row_processing', 'finalising'] as const;

export interface WatchdogOutcome {
  abandoned: number;
  stuck: number;
  campaignStalled: number;
  bulkPurged: number;
  submissionsPurged: number;
}

export async function runWatchdog(): Promise<WatchdogOutcome> {
  const log = logger.child({ operation: 'cron.watchdog' });
  const start = Date.now();

  const abandonedAt = new Date(Date.now() - ABANDONED_PENDING_HOURS * 60 * 60 * 1000);
  const stuckAt = new Date(Date.now() - STUCK_INFLIGHT_MINUTES * 60 * 1000);
  const retentionCutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const abandoned = await getDb()
    .update(schema.bulkUploads)
    .set({ status: 'failed', statusReason: 'upload_abandoned', updatedAt: new Date() })
    .where(
      and(eq(schema.bulkUploads.status, 'pending'), lt(schema.bulkUploads.createdAt, abandonedAt)),
    )
    .returning({ id: schema.bulkUploads.id });

  const stuck = await getDb()
    .update(schema.bulkUploads)
    .set({ status: 'failed', statusReason: 'processing_stuck', updatedAt: new Date() })
    .where(
      and(
        inArray(schema.bulkUploads.status, [...INFLIGHT_STATUSES]),
        isNotNull(schema.bulkUploads.lastProgressAt),
        lt(schema.bulkUploads.lastProgressAt, stuckAt),
      ),
    )
    .returning({ id: schema.bulkUploads.id });

  // Campaign async-job watchdog: a `processing` job whose heartbeat
  // (`last_progress_at`) has gone stale is failed out with `stalled` so the
  // caller's poll surfaces it instead of hanging on a dead worker. Items
  // already at a terminal status (resolved/submitted/sent/skipped/failed)
  // keep it. Any item STILL `pending` is force-failed too, inside
  // `auditStalledJob` (`failPendingItems`, mirroring the in-worker
  // final-attempt-failure path) — `stalled` means the worker died mid-run, so
  // leftover `pending` items are the NORMAL case here, not an edge case.
  // Without this, `GET /v1/campaign/{channel}/{id}` would show those items
  // `pending` forever, and the completed audit row's counts (#617 follow-up)
  // would silently undercount instead of summing to the job's real total.
  // Retention of the exported CSV is an external S3 lifecycle rule.
  const campaignStalledAt = new Date(Date.now() - config.CAMPAIGN_STALL_SECONDS * 1000);
  const campaignStalled = await getDb()
    .update(schema.campaignJob)
    .set({ status: 'failed', errorReason: 'stalled', updatedAt: new Date() })
    .where(
      and(
        eq(schema.campaignJob.status, 'processing'),
        isNotNull(schema.campaignJob.lastProgressAt),
        lt(schema.campaignJob.lastProgressAt, campaignStalledAt),
      ),
    )
    .returning({
      id: schema.campaignJob.id,
      // Free on this UPDATE (already loaded for the WHERE/SET), and exactly
      // what the `completed` audit row (#617 follow-up) needs: `channel` to
      // record which surface stalled, `signalstackOrgId` for `actorOrgId`,
      // `requestedBy` so an export-channel row can recompute the same
      // operator `recipientRef` a normal completion carries (never a
      // participant address — see `resolveExportRecipient`).
      channel: schema.campaignJob.channel,
      signalstackOrgId: schema.campaignJob.signalstackOrgId,
      requestedBy: schema.campaignJob.requestedBy,
    });

  // Terminal transition, so — per #617 §6 — it must get a `completed` audit
  // row: this is the case where the worker died mid-run, possibly after
  // already releasing data to some participants, and it is the one terminal
  // path that previously left the job's `requested` row with no matching
  // `completed` row, forever. Best-effort per job: one job's audit failure
  // must never skip the rest, nor the retention sweep below.
  for (const stalledJob of campaignStalled) {
    await auditStalledJob(stalledJob, log);
  }

  // Actively purge the Redis working set (incl. the PII-bearing `:lines` and
  // `:errors` keys) for uploads we just marked failed — the happy-path DEL in
  // bulk-finalise never runs for these. The per-key TTL is the backstop if this
  // pass is missed; this makes cleanup immediate. `abandoned` uploads are still
  // `pending` (usually no keys written yet) — DEL is a harmless no-op there.
  const terminalIds = [...abandoned, ...stuck].map((r) => r.id);
  let redisKeysPurged = 0;
  if (terminalIds.length > 0) {
    const keys = terminalIds.flatMap((id) => bulkRedisKeys(id));
    redisKeysPurged = await getRedis().del(...keys);
  }

  // Retention: terminal-status bulk uploads beyond cutoff. Keep onboarding
  // rollups untouched (forever per design); cascade FK from
  // link_submission.participant_id is set null on participant delete, but
  // we don't sweep participants.
  const bulkPurged = await getDb()
    .delete(schema.bulkUploads)
    .where(
      and(
        inArray(schema.bulkUploads.status, ['completed', 'failed', 'file_failed']),
        lt(schema.bulkUploads.createdAt, retentionCutoff),
      ),
    )
    .returning({ id: schema.bulkUploads.id });

  const submissionsPurged = await getDb()
    .delete(schema.linkSubmissions)
    .where(
      and(
        isNotNull(schema.linkSubmissions.rolledUpAt),
        lt(schema.linkSubmissions.createdAt, retentionCutoff),
      ),
    )
    .returning({ id: schema.linkSubmissions.id });

  log.info({
    status: 'success',
    latency_ms: Date.now() - start,
    abandoned: abandoned.length,
    stuck: stuck.length,
    campaign_stalled: campaignStalled.length,
    redis_keys_purged: redisKeysPurged,
    bulk_purged: bulkPurged.length,
    submissions_purged: submissionsPurged.length,
  });

  return {
    abandoned: abandoned.length,
    stuck: stuck.length,
    campaignStalled: campaignStalled.length,
    bulkPurged: bulkPurged.length,
    submissionsPurged: submissionsPurged.length,
  };
}

/** Shape of one row from the campaign-stall sweep's `.returning()`. */
interface StalledCampaignJob {
  id: string;
  channel: CampaignChannel;
  signalstackOrgId: string;
  requestedBy: string;
}

/**
 * Writes the `completed` PII-audit row for one job the stall sweep just
 * force-failed (#617 follow-up).
 *
 * Three independent best-effort steps, none of which can propagate a
 * failure out of this function (and so can never abort the sweep loop or the
 * retention pass after it):
 *
 * 1. `failPendingItems` force-fails every item STILL `pending` on this job —
 *    the normal case for a stalled job, since `stalled` means the worker
 *    died mid-run. This must run BEFORE the count read below, mirroring
 *    `campaign-process/index.ts`'s final-attempt-failure path: without it,
 *    `countItems` would return items in the `pending` bucket, which maps to
 *    NO audit column at all — the exact "counts that lie" failure this
 *    write exists to prevent (a 10-item job that stalled after resolving 3
 *    would otherwise audit `resolvedCount: 3` against 10 requested, with
 *    the other 7 vanishing with no signal). Wrapped in its own try/catch —
 *    a failure here still lets the audit row go out (with whatever counts
 *    `countItems` finds), rather than skipping the row entirely.
 * 2. The item-count read (`countItems`) is wrapped in its own try/catch — a
 *    failure there still lets the audit row go out, just without counts,
 *    rather than skipping the row entirely.
 * 3. The audit write itself goes through {@link safeAudit}, which already
 *    handles both of the writer's failure shapes (a thrown exception and a
 *    resolved `err(BaseError)`) and never rethrows.
 *
 * `recipientRef`/`destination` (export channel only) come from the shared
 * `exportAuditExtras` (`campaign-process/index.ts`) — the same function the
 * in-worker terminal paths call, so this sweep cannot drift from them the
 * way two hand-maintained twins would.
 *
 * @param stalledJob - One row from the campaign-stall sweep's `.returning()`.
 * @param log - The watchdog's structured logger.
 */
async function auditStalledJob(
  stalledJob: StalledCampaignJob,
  log: SafeAuditLogger,
): Promise<void> {
  try {
    await failPendingItems(stalledJob.id, 'stalled');
  } catch (cause) {
    log.error({
      operation: 'campaignAudit.completed',
      status: 'failure',
      job_id: stalledJob.id,
      channel: stalledJob.channel,
      reason: 'fail_pending_items_failed',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  let counts: Awaited<ReturnType<typeof countItems>> | undefined;
  try {
    counts = await countItems(stalledJob.id);
  } catch (cause) {
    log.error({
      operation: 'campaignAudit.completed',
      status: 'failure',
      job_id: stalledJob.id,
      channel: stalledJob.channel,
      reason: 'counts_unavailable',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  await safeAudit(
    () =>
      getCampaignAuditWriter().recordCompleted({
        correlationId: stalledJob.id,
        channel: stalledJob.channel,
        actorOrgId: stalledJob.signalstackOrgId,
        outcome: 'failed',
        errorCode: 'stalled',
        completedAt: new Date(),
        ...(counts ? toAuditCounts(counts) : {}),
        ...exportAuditExtras(stalledJob, {
          recipientMode: config.CAMPAIGN_EXPORT_RECIPIENT,
          ...(config.EXPORT_NETWORK_ADMIN_EMAIL
            ? { networkAdminEmail: config.EXPORT_NETWORK_ADMIN_EMAIL }
            : {}),
        }),
      }),
    log,
    { operation: 'campaignAudit.completed', job_id: stalledJob.id, channel: stalledJob.channel },
  );
}
