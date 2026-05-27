import { describe, expect, it } from 'vitest';
import { HISTOGRAM_VIEWS } from '../views.js';

describe('HISTOGRAM_VIEWS', () => {
  it('includes views for each histogram family in design §4.2', () => {
    const names = HISTOGRAM_VIEWS.map((v) => v.instrumentName);
    expect(names).toContain('api.request.duration_ms');
    expect(names).toContain('db.call.duration_ms');
    expect(names).toContain('signalstack.duration_ms');
    expect(names).toContain('worker.job.duration_ms');
    expect(names).toContain('worker.bulk_row.duration_ms');
  });

  it('api.request.duration_ms uses the §4.2 bucket boundaries', () => {
    const v = HISTOGRAM_VIEWS.find((x) => x.instrumentName === 'api.request.duration_ms');
    expect(v?.boundaries).toEqual([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
  });
});
