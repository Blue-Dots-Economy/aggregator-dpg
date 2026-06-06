/**
 * In-memory adapter for the outbound dispatch log.
 *
 * Process-local Maps, suitable for unit tests. Mirrors the Postgres
 * adapter's external behaviour: idempotency on the composite key, terminal
 * state transitions, attempt counter on failure.
 */

import { randomUUID } from 'node:crypto';
import { DomainError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import {
  OutboundDispatchLogBase,
  type EnqueueInput,
  type OutboundDispatchRow,
} from './interface.js';

/**
 * Pure-memory implementation. Used by `apps/api` unit tests and any
 * other in-process consumer that doesn't want to spin up a Postgres
 * dependency.
 */
export class InMemoryOutboundDispatchLog extends OutboundDispatchLogBase {
  /** Primary store keyed on row id. */
  protected readonly byId = new Map<string, OutboundDispatchRow>();
  /** Idempotency index keyed on `participantId|itemId|channel|templateId` → row id. */
  protected readonly byKey = new Map<string, string>();

  override async enqueue(input: EnqueueInput): Promise<Result<OutboundDispatchRow, BaseError>> {
    const key = idempotencyKey(
      input.participant_id,
      input.item_id,
      input.channel,
      input.template_id,
    );
    const existingId = this.byKey.get(key);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) return ok(existing);
      // Fell through — index out of sync. Clear stale key and re-insert below.
      this.byKey.delete(key);
    }

    const now = new Date();
    const row: OutboundDispatchRow = {
      id: randomUUID(),
      aggregatorId: input.aggregator_id,
      participantId: input.participant_id,
      itemId: input.item_id,
      channel: input.channel,
      templateId: input.template_id,
      status: 'queued',
      attempt: 0,
      error: null,
      payload: input.payload ?? {},
      queuedAt: now,
      sentAt: null,
      createdAt: now,
    };
    this.byId.set(row.id, row);
    this.byKey.set(key, row.id);
    return ok(row);
  }

  override async markSent(id: string): Promise<Result<OutboundDispatchRow, BaseError>> {
    const row = this.byId.get(id);
    if (!row) {
      return err(new DomainError(`dispatch row not found: ${id}`, { code: 'NOT_FOUND' }));
    }
    if (row.status !== 'queued') {
      return err(
        new DomainError(`cannot mark sent — status is ${row.status}`, {
          code: 'INVALID_TRANSITION',
        }),
      );
    }
    const next: OutboundDispatchRow = {
      ...row,
      status: 'sent',
      sentAt: new Date(),
    };
    this.byId.set(id, next);
    return ok(next);
  }

  override async markFailed(
    id: string,
    error: string,
  ): Promise<Result<OutboundDispatchRow, BaseError>> {
    const row = this.byId.get(id);
    if (!row) {
      return err(new DomainError(`dispatch row not found: ${id}`, { code: 'NOT_FOUND' }));
    }
    const next: OutboundDispatchRow = {
      ...row,
      status: 'failed',
      error,
      attempt: row.attempt + 1,
    };
    this.byId.set(id, next);
    return ok(next);
  }

  override async markSkippedLifecycle(id: string): Promise<Result<OutboundDispatchRow, BaseError>> {
    const row = this.byId.get(id);
    if (!row) {
      return err(new DomainError(`dispatch row not found: ${id}`, { code: 'NOT_FOUND' }));
    }
    if (row.status !== 'queued') {
      return err(
        new DomainError(`cannot mark skipped_lifecycle — status is ${row.status}`, {
          code: 'INVALID_TRANSITION',
        }),
      );
    }
    const next: OutboundDispatchRow = {
      ...row,
      status: 'skipped_lifecycle',
    };
    this.byId.set(id, next);
    return ok(next);
  }

  override async findById(id: string): Promise<Result<OutboundDispatchRow | null, BaseError>> {
    return ok(this.byId.get(id) ?? null);
  }

  override async listByParticipant(
    participantId: string,
  ): Promise<Result<OutboundDispatchRow[], BaseError>> {
    const rows = [...this.byId.values()]
      .filter((r) => r.participantId === participantId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return ok(rows);
  }
}

/**
 * Cross-package test fake alias. Mirrors the convention used by every
 * other service in `apps/api/src/services/*` — same class, exported
 * under the public `*Fake` name so tests don't reach into the internal
 * `InMemory*` symbol.
 */
export class OutboundDispatchLogFake extends InMemoryOutboundDispatchLog {}

/** Computes the composite idempotency key. */
function idempotencyKey(
  participantId: string,
  itemId: string,
  channel: string,
  templateId: string,
): string {
  return `${participantId}|${itemId}|${channel}|${templateId}`;
}
