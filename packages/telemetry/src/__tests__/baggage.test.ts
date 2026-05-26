import { describe, expect, it } from 'vitest';
import { context, propagation } from '@opentelemetry/api';
import { setAggregatorBaggage, setRequestIdBaggage, getAggregatorId } from '../baggage.js';

describe('aggregator baggage helpers', () => {
  it('round-trips aggregator_id through baggage', () => {
    setAggregatorBaggage('agg-42');
    expect(getAggregatorId()).toBe('agg-42');
  });

  it('returns undefined when unset', () => {
    context.with(propagation.setBaggage(context.active(), propagation.createBaggage({})), () => {
      expect(getAggregatorId()).toBeUndefined();
    });
  });

  it('setRequestIdBaggage stamps x_request_id', () => {
    setRequestIdBaggage('req-123');
    const baggage = propagation.getBaggage(context.active());
    expect(baggage?.getEntry('x_request_id')?.value).toBe('req-123');
  });
});
