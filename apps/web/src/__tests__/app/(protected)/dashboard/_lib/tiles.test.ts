import { describe, it, expect } from 'vitest';
import { tileSub } from '@/app/(protected)/dashboard/_lib/tiles';

const t = Object.assign(
  (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  {
    rich: () => '',
    markup: () => '',
    raw: () => '',
    has: () => true,
  },
);

describe('tileSub', () => {
  it('returns the completion share of all profiles', () => {
    expect(
      tileSub('complete_profiles', t, 'Seekers', { total_items: 3, complete_profiles: 2 }),
    ).toBe('ministat.sub_complete:{"pct":67}');
  });

  it('has no completion share without a rollup or with zero items', () => {
    expect(tileSub('complete_profiles', t, 'Seekers', undefined)).toBeUndefined();
    expect(
      tileSub('complete_profiles', t, 'Seekers', { total_items: 0, complete_profiles: 0 }),
    ).toBeUndefined();
  });

  it('returns the copy for the other known fields and nothing for unknown ones', () => {
    expect(tileSub('total_items', t, 'Seekers', undefined)).toBe(
      'ministat.sub_total:{"entityPlural":"Seekers"}',
    );
    expect(tileSub('has_applications', t, 'S', undefined)).toBe('ministat.sub_applications');
    expect(tileSub('total_users', t, 'S', undefined)).toBe('ministat.sub_totalUsers');
    expect(tileSub('avg_items_per_user', t, 'S', undefined)).toBe('ministat.sub_avgItems');
    expect(tileSub('avg_actions_per_user', t, 'S', undefined)).toBe('ministat.sub_avgActions');
    expect(tileSub('mystery', t, 'S', undefined)).toBeUndefined();
  });
});
