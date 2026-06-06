/**
 * Unit tests for the outbound-dispatch processor.
 *
 * The processor doesn't touch BullMQ, the DB, or the network — its
 * dependencies are injected. Tests pair the real
 * `SignalStackWriterFake` with a tiny local LogFake so we don't reach
 * across into `apps/api` (different deployable unit) for the dispatcher
 * log shape.
 */
import { describe, it, expect, vi } from 'vitest';

import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import {
  processOutboundDispatch,
  type DispatcherLog,
  type OutboundDispatchRow,
} from '../../jobs/outbound-dispatch.js';

type StoredRow = OutboundDispatchRow & {
  status: 'queued' | 'sent' | 'failed' | 'skipped_lifecycle';
  attempt: number;
  error: string | null;
};

/**
 * In-test fake of the worker's {@link DispatcherLog} surface. Mirrors the
 * real apps/api OutboundDispatchLog in just the methods the processor
 * calls, plus a seed helper for arrange-act-assert.
 */
class LogFake implements DispatcherLog {
  rows = new Map<string, StoredRow>();
  seed(row: OutboundDispatchRow & { status?: StoredRow['status'] }): void {
    this.rows.set(row.id, {
      id: row.id,
      itemId: row.itemId,
      channel: row.channel,
      templateId: row.templateId,
      payload: row.payload,
      status: row.status ?? 'queued',
      attempt: 0,
      error: null,
    });
  }
  async findById(
    id: string,
  ): Promise<
    { success: true; value: OutboundDispatchRow | null } | { success: false; error: Error }
  > {
    const r = this.rows.get(id);
    if (!r) return { success: true, value: null };
    return {
      success: true,
      value: {
        id: r.id,
        itemId: r.itemId,
        channel: r.channel,
        templateId: r.templateId,
        payload: r.payload,
      },
    };
  }
  async markSent(id: string): Promise<unknown> {
    const r = this.rows.get(id);
    if (r) r.status = 'sent';
    return;
  }
  async markFailed(id: string, error: string): Promise<unknown> {
    const r = this.rows.get(id);
    if (r) {
      r.status = 'failed';
      r.attempt += 1;
      r.error = error;
    }
    return;
  }
  async markSkippedLifecycle(id: string): Promise<unknown> {
    const r = this.rows.get(id);
    if (r) r.status = 'skipped_lifecycle';
    return;
  }
}

describe('processOutboundDispatch', () => {
  it('marks skipped_lifecycle when signals item is no longer draft', async () => {
    const ss = new SignalStackWriterFake();
    ss.seedItem('item-1', { lifecycle_status: 'live' });
    const log = new LogFake();
    log.seed({
      id: 'd-1',
      itemId: 'item-1',
      channel: 'sms',
      templateId: 't',
      payload: {},
    });

    await processOutboundDispatch({ dispatchId: 'd-1' }, { signalstack: ss, log });

    expect(log.rows.get('d-1')!.status).toBe('skipped_lifecycle');
  });

  it('marks sent on a draft item (stub channel)', async () => {
    const ss = new SignalStackWriterFake();
    ss.seedItem('item-1', { lifecycle_status: 'draft' });
    const log = new LogFake();
    log.seed({
      id: 'd-1',
      itemId: 'item-1',
      channel: 'sms',
      templateId: 't',
      payload: { phone: '+918888888888' },
    });
    const sender = vi.fn(async () => ({
      success: true as const,
      value: { provider_msg_id: 'msg-1' },
    }));

    await processOutboundDispatch({ dispatchId: 'd-1' }, { signalstack: ss, log, sender });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(log.rows.get('d-1')!.status).toBe('sent');
  });

  it('marks failed and bumps attempt on sender error', async () => {
    const ss = new SignalStackWriterFake();
    ss.seedItem('item-1', { lifecycle_status: 'draft' });
    const log = new LogFake();
    log.seed({
      id: 'd-1',
      itemId: 'item-1',
      channel: 'sms',
      templateId: 't',
      payload: {},
    });
    const sender = vi.fn(async () => ({
      success: false as const,
      error: new Error('vendor down'),
    }));

    await processOutboundDispatch({ dispatchId: 'd-1' }, { signalstack: ss, log, sender });

    expect(log.rows.get('d-1')!.status).toBe('failed');
    expect(log.rows.get('d-1')!.attempt).toBe(1);
    expect(log.rows.get('d-1')!.error).toBe('vendor down');
  });

  it('is a no-op when the row does not exist', async () => {
    const ss = new SignalStackWriterFake();
    const log = new LogFake();

    await expect(
      processOutboundDispatch({ dispatchId: 'nope' }, { signalstack: ss, log }),
    ).resolves.toBeUndefined();
  });

  it('sends when signals returns null for the item (lifecycle indeterminate → assume still draft)', async () => {
    // Edge case: signals doesn't know the item yet (race). Don't skip —
    // try to send.
    const ss = new SignalStackWriterFake();
    const log = new LogFake();
    log.seed({
      id: 'd-1',
      itemId: 'item-1',
      channel: 'sms',
      templateId: 't',
      payload: {},
    });
    const sender = vi.fn(async () => ({
      success: true as const,
      value: { provider_msg_id: 'msg-1' },
    }));

    await processOutboundDispatch({ dispatchId: 'd-1' }, { signalstack: ss, log, sender });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(log.rows.get('d-1')!.status).toBe('sent');
  });
});
