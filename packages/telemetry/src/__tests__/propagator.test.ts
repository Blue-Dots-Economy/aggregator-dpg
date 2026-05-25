import { describe, expect, it } from 'vitest';
import { propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { configurePropagator } from '../propagator.js';

describe('configurePropagator', () => {
  it('installs a propagator that extracts traceparent and baggage', () => {
    configurePropagator();
    const ctx = propagation.extract(ROOT_CONTEXT, {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      baggage: 'aggregator_id=agg-1',
    });
    const baggage = propagation.getBaggage(ctx);
    expect(baggage?.getEntry('aggregator_id')?.value).toBe('agg-1');
  });
});
