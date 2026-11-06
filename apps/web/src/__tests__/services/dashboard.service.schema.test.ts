/**
 * Unit tests: the dashboard payload schema accepts what Signals sends.
 */
import { describe, it, expect } from 'vitest';
import { DashboardPageSchema } from '@/services/dashboard.service';

const slice = {
  rollup: { total_items: 0, complete_profiles: 0, by_status: {} },
  items: [],
  total_matching: 0,
  next_cursor: null,
};

describe('DashboardPageSchema', () => {
  it('accepts a payload with a computed time', () => {
    const parsed = DashboardPageSchema.safeParse({
      by_domain: { seeker: slice },
      metadata: {
        last_computed_at: '2026-01-01T00:00:00.000Z',
        ttl_seconds: 3600,
        refreshed: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a null computed time, which Signals sends for a fresh rollup', () => {
    const parsed = DashboardPageSchema.safeParse({
      by_domain: { seeker: slice, provider: slice },
      metadata: { last_computed_at: null, ttl_seconds: 3600, refreshed: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts metadata without a computed time', () => {
    const parsed = DashboardPageSchema.safeParse({ by_domain: {}, metadata: {} });
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload without by_domain', () => {
    const parsed = DashboardPageSchema.safeParse({ metadata: {} });
    expect(parsed.success).toBe(false);
  });
});
