import { describe, expect, it, vi } from 'vitest';
import { OutcomeTracker } from '../outcome-tracker.js';

const makeMeter = () => ({
  createCounter: vi.fn(() => ({ add: vi.fn() })),
  createHistogram: vi.fn(() => ({ record: vi.fn() })),
  createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
});

describe('OutcomeTracker', () => {
  it('creates instruments declared in config at boot', () => {
    const meter = makeMeter();
    new OutcomeTracker({
      metrics: [
        {
          name: 'participant.registered.total',
          instrument: 'counter',
          attributes: ['aggregator_id_bucket'],
        },
        { name: 'bulk_upload.row.duration_ms', instrument: 'histogram' },
      ],
      meter: meter as never,
    });
    expect(meter.createCounter).toHaveBeenCalledWith(
      'participant.registered.total',
      expect.any(Object),
    );
    expect(meter.createHistogram).toHaveBeenCalledWith(
      'bulk_upload.row.duration_ms',
      expect.any(Object),
    );
  });

  it('increments the matching counter on emit', () => {
    const counterAdd = vi.fn();
    const meter = {
      createCounter: vi.fn(() => ({ add: counterAdd })),
      createHistogram: vi.fn(() => ({ record: vi.fn() })),
      createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
    };
    const tracker = new OutcomeTracker({
      metrics: [
        {
          name: 'participant.registered.total',
          instrument: 'counter',
          on_event: 'participant.created',
          attributes: ['source'],
        },
      ],
      meter: meter as never,
    });
    tracker.process({ event: 'participant.created', attributes: { source: 'csv' } });
    expect(counterAdd).toHaveBeenCalledWith(1, { source: 'csv' });
  });

  it('skips metrics whose on_event does not match', () => {
    const counterAdd = vi.fn();
    const meter = {
      createCounter: vi.fn(() => ({ add: counterAdd })),
      createHistogram: vi.fn(() => ({ record: vi.fn() })),
      createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
    };
    const tracker = new OutcomeTracker({
      metrics: [{ name: 'a', instrument: 'counter', on_event: 'event.a' }],
      meter: meter as never,
    });
    tracker.process({ event: 'event.b', attributes: {} });
    expect(counterAdd).not.toHaveBeenCalled();
  });
});
