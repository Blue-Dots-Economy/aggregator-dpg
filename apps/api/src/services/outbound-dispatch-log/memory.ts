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
 * Partial seed shape — the arrange step supplies the few fields it cares
 * about; the rest fall back to sensible defaults from
 * {@link buildOutboundDispatchRow}.
 */
export interface OutboundDispatchSeed extends Partial<OutboundDispatchRow> {
  aggregatorId: string;
  participantId: string;
  itemId: string;
  channel: 'sms' | 'voice' | 'chat';
  templateId: string;
}

/**
 * Builds a fully-populated `OutboundDispatchRow` from a partial seed.
 * Unspecified fields default to a freshly-queued row.
 */
export function buildOutboundDispatchRow(seed: OutboundDispatchSeed): OutboundDispatchRow {
  const now = seed.createdAt ?? new Date();
  return {
    id: seed.id ?? randomUUID(),
    aggregatorId: seed.aggregatorId,
    participantId: seed.participantId,
    itemId: seed.itemId,
    channel: seed.channel,
    templateId: seed.templateId,
    status: seed.status ?? 'queued',
    attempt: seed.attempt ?? 0,
    error: seed.error ?? null,
    payload: seed.payload ?? {},
    queuedAt: seed.queuedAt ?? now,
    sentAt: seed.sentAt ?? null,
    createdAt: now,
  };
}

/**
 * Cross-package test fake. Mirrors the convention used by every other
 * service in `apps/api/src/services/*` — same class, exported under the
 * public `*Fake` name so tests don't reach into the internal `InMemory*`
 * symbol. Adds a `seed()` helper for arrange-act-assert tests.
 */
export class OutboundDispatchLogFake extends InMemoryOutboundDispatchLog {
  /**
   * Inserts the given rows directly into the underlying store, bypassing
   * the writer methods. Useful for tests that need a pre-existing row in
   * a non-default state (`sent`, `failed`, `skipped_lifecycle`) without
   * walking the state machine.
   *
   * Re-seeding the same idempotency key overwrites the previous row.
   */
  seed(seeds: OutboundDispatchSeed[]): void {
    for (const s of seeds) {
      const row = buildOutboundDispatchRow(s);
      const key = idempotencyKey(row.participantId, row.itemId, row.channel, row.templateId);
      const existingId = this.byKey.get(key);
      if (existingId) this.byId.delete(existingId);
      this.byId.set(row.id, row);
      this.byKey.set(key, row.id);
    }
  }
}

/** Computes the composite idempotency key. */
function idempotencyKey(
  participantId: string,
  itemId: string,
  channel: string,
  templateId: string,
): string {
  return `${participantId}|${itemId}|${channel}|${templateId}`;
}
