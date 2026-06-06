/**
 * Spec for the OutboundDispatchLog service.
 *
 * Exercises the in-memory fake which mirrors the Postgres adapter's external
 * contract — most importantly the idempotency invariant on the composite
 * key `(participant_id, item_id, channel, template_id)` and the terminal
 * state transitions (`markSent` / `markFailed` / `markSkippedLifecycle`).
 */

import { describe, expect, it } from 'vitest';
import { OutboundDispatchLogFake } from '../memory.js';

describe('OutboundDispatchLog', () => {
  it('enqueue is idempotent on (participant_id,item_id,channel,template_id)', async () => {
    const store = new OutboundDispatchLogFake();
    const a = await store.enqueue({
      aggregator_id: '11111111-1111-4111-8111-111111111111',
      participant_id: '22222222-2222-4222-8222-222222222222',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: { delay_seconds: 0, max_retries: 3 },
    });
    const b = await store.enqueue({
      aggregator_id: '11111111-1111-4111-8111-111111111111',
      participant_id: '22222222-2222-4222-8222-222222222222',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: { delay_seconds: 0, max_retries: 3 },
    });
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) {
      expect(a.value.id).toBe(b.value.id); // same row returned both times
    }
    const list = await store.listByParticipant('22222222-2222-4222-8222-222222222222');
    expect(list.success && list.value.length).toBe(1);
  });

  it('seeds a queued row with attempt=0 and status="queued"', async () => {
    const store = new OutboundDispatchLogFake();
    const r = await store.enqueue({
      aggregator_id: '11111111-1111-4111-8111-111111111111',
      participant_id: '22222222-2222-4222-8222-222222222222',
      item_id: 'i',
      channel: 'voice',
      template_id: 't',
      payload: {},
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.value.status).toBe('queued');
      expect(r.value.attempt).toBe(0);
      expect(r.value.id).toMatch(/^[0-9a-f-]{8}/); // some uuid-like string
    }
  });

  it('markSent flips status and sets sent_at', async () => {
    const store = new OutboundDispatchLogFake();
    const enq = await store.enqueue({
      aggregator_id: '11111111-1111-4111-8111-111111111111',
      participant_id: '22222222-2222-4222-8222-222222222222',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    if (!enq.success) throw new Error('seed failed');
    const sent = await store.markSent(enq.value.id);
    expect(sent.success).toBe(true);
    const fetched = await store.findById(enq.value.id);
    expect(fetched.success).toBe(true);
    if (fetched.success && fetched.value) {
      expect(fetched.value.status).toBe('sent');
      expect(fetched.value.sentAt).toBeInstanceOf(Date);
    }
  });

  it('markFailed bumps attempt and stores error', async () => {
    const store = new OutboundDispatchLogFake();
    const enq = await store.enqueue({
      aggregator_id: '11111111-1111-4111-8111-111111111111',
      participant_id: '22222222-2222-4222-8222-222222222222',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    if (!enq.success) throw new Error('seed failed');
    const failed = await store.markFailed(enq.value.id, 'vendor down');
    expect(failed.success).toBe(true);
    const fetched = await store.findById(enq.value.id);
    if (fetched.success && fetched.value) {
      expect(fetched.value.status).toBe('failed');
      expect(fetched.value.error).toBe('vendor down');
      expect(fetched.value.attempt).toBe(1);
    }
  });

  it('markSkippedLifecycle is terminal (no attempt bump)', async () => {
    const store = new OutboundDispatchLogFake();
    const enq = await store.enqueue({
      aggregator_id: '11111111-1111-4111-8111-111111111111',
      participant_id: '22222222-2222-4222-8222-222222222222',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    if (!enq.success) throw new Error('seed failed');
    const skipped = await store.markSkippedLifecycle(enq.value.id);
    expect(skipped.success).toBe(true);
    const fetched = await store.findById(enq.value.id);
    if (fetched.success && fetched.value) {
      expect(fetched.value.status).toBe('skipped_lifecycle');
      expect(fetched.value.attempt).toBe(0);
    }
  });

  it('findById returns null when row absent', async () => {
    const store = new OutboundDispatchLogFake();
    const r = await store.findById('00000000-0000-4000-8000-000000000000');
    expect(r.success).toBe(true);
    if (r.success) expect(r.value).toBeNull();
  });

  it('markSent refuses to flip non-queued rows', async () => {
    const store = new OutboundDispatchLogFake();
    const enq = await store.enqueue({
      aggregator_id: '11111111-1111-4111-8111-111111111111',
      participant_id: '22222222-2222-4222-8222-222222222222',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    if (!enq.success) throw new Error('seed failed');
    const first = await store.markSent(enq.value.id);
    expect(first.success).toBe(true);
    const second = await store.markSent(enq.value.id);
    expect(second.success).toBe(false);
  });
});
