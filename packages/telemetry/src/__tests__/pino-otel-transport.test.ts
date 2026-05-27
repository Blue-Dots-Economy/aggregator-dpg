import { describe, expect, it, vi } from 'vitest';
import { handleRecord } from '../pino-otel-transport.js';

describe('pino-otel-transport', () => {
  it('emits a log record with body, attributes, and trace ids from the record', () => {
    const emit = vi.fn();
    handleRecord(
      {
        level: 30,
        msg: 'hello',
        time: 1,
        foo: 'bar',
        trace_id: '0af7651916cd43dd8448eb211c80319c',
        span_id: 'b7ad6b7169203331',
      },
      { emit } as never,
    );
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.body).toBe('hello');
    expect(call.severityText).toBe('info');
    expect(call.attributes.foo).toBe('bar');
    expect(call.attributes['trace_id']).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(call.attributes['span_id']).toBe('b7ad6b7169203331');
  });

  it('emits a record without trace ids when the mixin did not add them', () => {
    const emit = vi.fn();
    handleRecord({ level: 30, msg: 'no trace', time: 1 }, { emit } as never);
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.attributes['trace_id']).toBeUndefined();
  });

  it('redacts attributes listed in piiFieldsExcluded', () => {
    const emit = vi.fn();
    handleRecord({ level: 30, msg: 'x', time: 1, phone: '555' }, { emit } as never, ['phone']);
    const call = emit.mock.calls[0][0];
    expect(call.attributes.phone).toBe('[REDACTED]');
  });

  it('maps each standard pino level to its label', () => {
    const emit = vi.fn();
    const cases: Array<[number, string]> = [
      [10, 'trace'],
      [20, 'debug'],
      [30, 'info'],
      [40, 'warn'],
      [50, 'error'],
      [60, 'fatal'],
    ];
    for (const [level, _label] of cases) {
      handleRecord({ level, msg: 'x', time: 1 }, { emit } as never);
    }
    const seen = emit.mock.calls.map((c) => c[0].severityText);
    expect(seen).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });

  it('falls back to numeric string for unknown levels', () => {
    const emit = vi.fn();
    handleRecord({ level: 25, msg: 'x', time: 1 }, { emit } as never);
    expect(emit.mock.calls[0][0].severityText).toBe('25');
  });
});
