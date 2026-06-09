/**
 * Outbound completion-dispatch processor.
 *
 * Reads one queued row from `outbound_dispatch_log`, re-checks the
 * signals item's lifecycle, then either dispatches via a channel adapter
 * (default = log-only stub) or marks the row `skipped_lifecycle`.
 *
 * Vendor wiring (Twilio etc.) is intentionally out of scope here — the
 * default {@link defaultSender} is a stub that logs and synthesises a
 * provider message id. Real adapters land in a follow-up spec.
 *
 * Cross-app type leak avoidance: the processor depends on a small local
 * {@link DispatcherLog} interface that mirrors the subset of
 * `OutboundDispatchLogBase` it actually calls (`findById`, `markSent`,
 * `markFailed`, `markSkippedLifecycle`). The worker entry-point adapts
 * the real `apps/api` service to this shape so this file stays
 * independent of `apps/api`.
 */

import type { OutboundDispatchJobData } from '@aggregator-dpg/queue';
import type { SignalStackWriterBase } from '@aggregator-dpg/signalstack-writer/interface';

import { logger } from '../logger.js';

// inlined from apps/api/src/services/onboarding/lifecycle.ts — keep in sync.
// dep-cruiser forbids worker → apps/api imports; the resolver is 5 lines.
type LifecycleStatus = 'draft' | 'live' | 'paused';
const VALID_LIFECYCLE = new Set<LifecycleStatus>(['draft', 'live', 'paused']);
function resolveLifecycle(
  item: { lifecycle_status?: LifecycleStatus | string } | null | undefined,
): LifecycleStatus | null {
  if (item == null) return null;
  const raw = item.lifecycle_status;
  if (raw === undefined) return 'live';
  return VALID_LIFECYCLE.has(raw as LifecycleStatus) ? (raw as LifecycleStatus) : 'live';
}

/**
 * Slim view of an outbound-dispatch row, scoped to the fields the
 * processor needs. Avoids importing the full `OutboundDispatchRow` from
 * `apps/api` — see file header.
 */
export interface OutboundDispatchRow {
  id: string;
  itemId: string;
  channel: 'sms' | 'voice' | 'chat';
  templateId: string;
  payload: Record<string, unknown>;
}

/**
 * Subset of the outbound dispatch log surface the processor uses. The
 * production wire-up (in `main.ts`) adapts
 * `OutboundDispatchLogBase` from `apps/api` to this shape; test code
 * provides a tiny local fake.
 *
 * Each method returns the `Result`-like envelope the underlying service
 * uses, but only the success / failure discriminator is consumed here.
 */
export interface DispatcherLog {
  findById(
    id: string,
  ): Promise<
    { success: true; value: OutboundDispatchRow | null } | { success: false; error: Error }
  >;
  markSent(id: string): Promise<unknown>;
  markFailed(id: string, error: string): Promise<unknown>;
  markSkippedLifecycle(id: string): Promise<unknown>;
}

/**
 * Channel sender contract — invoked once per row that survives the
 * lifecycle re-check. The stub default ({@link defaultSender}) logs and
 * synthesises a provider message id; real adapters (Twilio etc.) land
 * in a follow-up spec.
 */
export type ChannelSender = (row: {
  channel: 'sms' | 'voice' | 'chat';
  template_id: string;
  payload: Record<string, unknown>;
}) => Promise<
  { success: true; value: { provider_msg_id: string } } | { success: false; error: Error }
>;

/** Processor dependencies — injected so the unit tests stay deterministic. */
export interface Deps {
  signalstack: SignalStackWriterBase;
  log: DispatcherLog;
  sender?: ChannelSender;
}

/**
 * STUB sender. Logs an info entry and returns a synthetic provider
 * message id. The default for MVP; real vendor wiring is a follow-up.
 */
const defaultSender: ChannelSender = async (row) => {
  logger.info({
    operation: 'outboundDispatch.stub.send',
    status: 'success',
    channel: row.channel,
    template_id: row.template_id,
  });
  return { success: true, value: { provider_msg_id: `stub-${Date.now()}` } };
};

/**
 * Processes one outbound-dispatch BullMQ job.
 *
 * Flow:
 *   1. Load the queued row by `dispatchId`. Missing rows are a no-op
 *      (warn-logged) since signals replay or a stale enqueue may
 *      produce dangling job ids.
 *   2. Re-check the signals item lifecycle via the writer. A
 *      definitive non-draft status routes to `markSkippedLifecycle`.
 *      An indeterminate result (item not found by signals; getItem
 *      error) does NOT skip — drafts dominate the race so the send
 *      attempt proceeds.
 *   3. Dispatch via the configured channel adapter (default = stub).
 *      Success → `markSent`; failure → `markFailed` (which bumps
 *      `attempt` and stores the error message) **then re-throw** so
 *      BullMQ schedules the next attempt against the job's `attempts`
 *      option (set to `max_retries + 1` at enqueue time). Without the
 *      re-throw, the job resolves and is marked done after one try.
 *
 * Internal lookup / lifecycle errors do not throw — they are absorbed
 * (warn-logged) so a transient signals or DB blip doesn't burn the
 * entire retry budget.
 *
 * @param data - Job payload carrying the `dispatchId`.
 * @param deps - Injected signalstack writer + log adapter + optional sender.
 */
export async function processOutboundDispatch(
  data: OutboundDispatchJobData,
  deps: Deps,
): Promise<void> {
  const sender = deps.sender ?? defaultSender;

  const fetched = await deps.log.findById(data.dispatchId);
  if (!fetched.success) {
    logger.error({
      operation: 'outboundDispatch.lookup',
      status: 'failure',
      error: fetched.error.message,
      error_type: fetched.error.constructor?.name,
      dispatch_id: data.dispatchId,
    });
    return;
  }
  if (!fetched.value) {
    logger.warn({
      operation: 'outboundDispatch.notFound',
      status: 'skipped',
      dispatch_id: data.dispatchId,
    });
    return;
  }
  const row = fetched.value;

  // Lifecycle re-check. We only skip when signals returns a definitive
  // non-draft status. `ok(null)` (item not found) and `err` both leave
  // the lifecycle indeterminate — drafts dominate the race so we still
  // attempt the send.
  const probe = await deps.signalstack.getItem({ item_id: row.itemId });
  if (probe.success && probe.value) {
    const status = resolveLifecycle(
      probe.value.lifecycle_status !== undefined
        ? { lifecycle_status: probe.value.lifecycle_status }
        : {},
    );
    if (status && status !== 'draft') {
      logger.info({
        operation: 'outboundDispatch.skipped',
        status: 'skipped',
        sub: 'lifecycle',
        dispatch_id: row.id,
        lifecycle_status: status,
      });
      await deps.log.markSkippedLifecycle(row.id);
      return;
    }
  }

  // Send via the channel adapter (stub default).
  const sent = await sender({
    channel: row.channel,
    template_id: row.templateId,
    payload: row.payload,
  });
  if (sent.success) {
    logger.info({
      operation: 'outboundDispatch.send',
      status: 'success',
      dispatch_id: row.id,
      channel: row.channel,
      template_id: row.templateId,
      provider_msg_id: sent.value.provider_msg_id,
    });
    await deps.log.markSent(row.id);
    return;
  }
  logger.error({
    operation: 'outboundDispatch.send',
    status: 'failure',
    dispatch_id: row.id,
    channel: row.channel,
    template_id: row.templateId,
    error: sent.error.message,
    error_type: sent.error.constructor?.name,
  });
  await deps.log.markFailed(row.id, sent.error.message);
  // Re-throw so BullMQ honours the job's `attempts` option (set from
  // the directive's `max_retries + 1` at enqueue time). Without this,
  // the job resolves successfully and is never retried.
  throw sent.error;
}
