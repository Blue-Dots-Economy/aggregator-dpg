/**
 * Outbound dispatch log contract.
 *
 * Persistence port for the `outbound_dispatch_log` table — one row per
 * completion-dispatch send attempt fired by the onboarding dispatcher
 * (sms / voice / chat). The composite unique key
 * `(participant_id, item_id, channel, template_id)` makes the `enqueue`
 * call idempotent: re-running the planner against the same signals
 * response cannot duplicate sends.
 *
 * Concrete adapters: Postgres for production, in-memory for tests.
 * Every method returns `Result<T, BaseError>` and never throws.
 */

import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { z } from 'zod';

/** Wire-protocol channels supported by the dispatcher. */
export const ChannelSchema = z.enum(['sms', 'voice', 'chat']);
export type Channel = z.infer<typeof ChannelSchema>;

/** Lifecycle of a dispatch row. */
export const StatusSchema = z.enum(['queued', 'sent', 'skipped_lifecycle', 'failed']);
export type Status = z.infer<typeof StatusSchema>;

/**
 * Input accepted by `enqueue`. The dispatcher planner produces one object
 * per planned send. Fields use snake_case to mirror the planner's output
 * and the underlying SQL column names.
 */
export const EnqueueInputSchema = z.object({
  aggregator_id: z.string().uuid(),
  participant_id: z.string().uuid(),
  item_id: z.string().min(1),
  channel: ChannelSchema,
  template_id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type EnqueueInput = z.infer<typeof EnqueueInputSchema>;

/** Domain shape of a row. camelCase TS keys mirror the Drizzle row. */
export interface OutboundDispatchRow {
  id: string;
  aggregatorId: string;
  participantId: string;
  itemId: string;
  channel: Channel;
  templateId: string;
  status: Status;
  attempt: number;
  error: string | null;
  payload: Record<string, unknown>;
  queuedAt: Date;
  sentAt: Date | null;
  createdAt: Date;
}

/**
 * Service contract for the outbound completion-dispatch audit log.
 *
 * Every mutation is idempotent on `(participant_id, item_id, channel, template_id)`.
 * Methods return `Result<T, BaseError>` — never throw.
 */
export abstract class OutboundDispatchLogBase {
  /**
   * Inserts a queued row OR returns the existing row matching the
   * idempotency key. Safe to call N times for the same enqueue input.
   *
   * @param input - Planner-produced dispatch envelope.
   * @returns The inserted (or pre-existing) dispatch row.
   */
  abstract enqueue(input: EnqueueInput): Promise<Result<OutboundDispatchRow, BaseError>>;

  /**
   * Transition `queued` → `sent`. Sets `sent_at = NOW()`.
   *
   * @param id - Row id returned by `enqueue`.
   * @returns Updated row on success; `DomainError` when the row is
   *          missing or not in `queued` status.
   */
  abstract markSent(id: string): Promise<Result<OutboundDispatchRow, BaseError>>;

  /**
   * Transition `queued` → `failed`. Bumps `attempt` and stores the
   * error message.
   *
   * @param id - Row id returned by `enqueue`.
   * @param error - Vendor / dispatcher failure detail.
   */
  abstract markFailed(id: string, error: string): Promise<Result<OutboundDispatchRow, BaseError>>;

  /**
   * Transition `queued` → `skipped_lifecycle`. Terminal; does NOT
   * bump `attempt`. Called when the underlying signals item has
   * moved out of `draft` before the send fires.
   *
   * @param id - Row id returned by `enqueue`.
   */
  abstract markSkippedLifecycle(id: string): Promise<Result<OutboundDispatchRow, BaseError>>;

  /**
   * Lookup by primary key.
   *
   * @param id - Row id.
   * @returns The row, or `null` value when absent (still a successful Result).
   */
  abstract findById(id: string): Promise<Result<OutboundDispatchRow | null, BaseError>>;

  /**
   * All rows for a participant, oldest-first.
   *
   * @param participantId - Participant UUID.
   */
  abstract listByParticipant(
    participantId: string,
  ): Promise<Result<OutboundDispatchRow[], BaseError>>;
}
