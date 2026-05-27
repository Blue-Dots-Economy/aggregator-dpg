import { describe, expect, it } from 'vitest';
import { TelemetryFake, buildSpanFixture } from '../index.js';

describe('TelemetryFake', () => {
  it('records spans and metrics in memory', () => {
    const fake = new TelemetryFake();
    fake.recordSpan(buildSpanFixture({ name: 'api.request', attributes: { route: '/health' } }));
    fake.recordMetric({
      name: 'api.requests',
      value: 1,
      attributes: { route: '/health', status: '200' },
    });

    expect(fake.spans).toHaveLength(1);
    expect(fake.spans[0].name).toBe('api.request');
    expect(fake.metrics).toHaveLength(1);
  });

  it('seed populates spans and metrics', () => {
    const fake = new TelemetryFake();
    fake.seed({
      spans: [buildSpanFixture({ name: 'pre-seeded' })],
      metrics: [{ name: 'pre.metric', value: 5, attributes: {} }],
    });
    expect(fake.spans[0].name).toBe('pre-seeded');
  });
});
