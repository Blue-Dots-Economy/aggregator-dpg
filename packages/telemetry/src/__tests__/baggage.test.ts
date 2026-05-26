import { describe, expect, it } from 'vitest';
import { context, propagation } from '@opentelemetry/api';
import { withAggregatorBaggage, withRequestIdBaggage, getAggregatorId } from '../baggage.js';

describe('aggregator baggage helpers', () => {
  it('round-trips aggregator_id through baggage inside the callback', async () => {
    await withAggregatorBaggage('agg-42', () => {
      expect(getAggregatorId()).toBe('agg-42');
    });
    // After the callback, baggage scope is gone.
    expect(getAggregatorId()).toBeUndefined();
  });

  it('returns undefined when unset', () => {
    expect(getAggregatorId()).toBeUndefined();
  });

  it('withRequestIdBaggage stamps x_request_id inside the callback', async () => {
    await withRequestIdBaggage('req-123', () => {
      const baggage = propagation.getBaggage(context.active());
      expect(baggage?.getEntry('x_request_id')?.value).toBe('req-123');
    });
  });

  it('callback return value propagates back', async () => {
    const result = await withAggregatorBaggage('agg-99', () => 42);
    expect(result).toBe(42);
  });
});
