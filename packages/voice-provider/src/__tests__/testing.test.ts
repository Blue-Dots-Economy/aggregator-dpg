/**
 * Unit tests for {@link InMemoryVoiceProvider} — the in-memory fake other
 * packages (apps/worker's voice handler) exercise against instead of a real
 * Raya connection.
 *
 * @module @aggregator-dpg/voice-provider
 */
import { describe, it, expect } from 'vitest';
import { InMemoryVoiceProvider } from '../testing.js';

describe('InMemoryVoiceProvider', () => {
  it('dispatch returns a providerBatchRef and accepts all contacts by default', async () => {
    const p = new InMemoryVoiceProvider();
    const r = await p.dispatch({
      agentRef: 'a',
      batchName: 'b',
      contacts: [{ ref: 'i1', name: 'A', phone: '9000000001', variables: { role: 'Electrician' } }],
      startOptions: { max_concurrent_calls: 5, selected_statuses: ['Pending'] },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.value.providerBatchRef).toBeTruthy();
    expect(r.value.accepted).toEqual(['i1']);
  });

  it('reports a per-row rejection', async () => {
    const p = new InMemoryVoiceProvider();
    p.setReject('i1', 'invalid phone');
    const r = await p.dispatch({
      agentRef: 'a',
      batchName: 'b',
      contacts: [{ ref: 'i1', name: 'A', phone: 'x', variables: {} }],
      startOptions: {},
    });
    if (!r.success) throw new Error('expected ok envelope');
    expect(r.value.rejected).toEqual([{ ref: 'i1', error: 'invalid phone' }]);
  });

  it('excludes a rejected contact from accepted and records the raw provider responses', async () => {
    const p = new InMemoryVoiceProvider();
    p.setReject('i1', 'invalid phone');
    const r = await p.dispatch({
      agentRef: 'a',
      batchName: 'b',
      contacts: [
        { ref: 'i1', name: 'A', phone: 'x', variables: {} },
        { ref: 'i2', name: 'B', phone: '9000000002', variables: {} },
      ],
      startOptions: {},
    });
    if (!r.success) throw new Error('expected ok envelope');
    expect(r.value.accepted).toEqual(['i2']);
    expect(r.value.providerResponse.create).toBeDefined();
    expect(r.value.providerResponse.start).toBeDefined();
  });

  it('records each dispatch call for test assertions', async () => {
    const p = new InMemoryVoiceProvider();
    await p.dispatch({
      agentRef: 'agent-1',
      batchName: 'batch-1',
      contacts: [{ ref: 'i1', name: 'A', phone: '9000000001', variables: {} }],
      startOptions: {},
    });
    expect(p.dispatches).toHaveLength(1);
    expect(p.dispatches[0]?.agentRef).toBe('agent-1');
  });

  it('setReject only affects the next matching dispatch call, not later ones', async () => {
    const p = new InMemoryVoiceProvider();
    p.setReject('i1', 'invalid phone');
    await p.dispatch({
      agentRef: 'a',
      batchName: 'b',
      contacts: [{ ref: 'i1', name: 'A', phone: 'x', variables: {} }],
      startOptions: {},
    });
    const second = await p.dispatch({
      agentRef: 'a',
      batchName: 'b',
      contacts: [{ ref: 'i1', name: 'A', phone: '9000000001', variables: {} }],
      startOptions: {},
    });
    if (!second.success) throw new Error('expected ok envelope');
    expect(second.value.rejected).toEqual([]);
    expect(second.value.accepted).toEqual(['i1']);
  });

  it('stop and update return a not-implemented error (inherited from the base)', async () => {
    const p = new InMemoryVoiceProvider();
    const stopResult = await p.stop('batch-1');
    const updateResult = await p.update('batch-1', {
      agentRef: 'a',
      batchName: 'b',
      contacts: [],
      startOptions: {},
    });
    expect(stopResult.success).toBe(false);
    expect(updateResult.success).toBe(false);
    if (stopResult.success || updateResult.success) return;
    expect(stopResult.error.code).toBe('NOT_IMPLEMENTED');
    expect(updateResult.error.code).toBe('NOT_IMPLEMENTED');
  });
});
