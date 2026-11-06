import { describe, it, expect } from 'vitest';
import {
  filterRowsByLifecycle,
  isLifecycleFilterValue,
  lifecycleQuery,
  parseLifecycleParam,
} from '@/app/(protected)/dashboard/_lib/lifecycle';

describe('isLifecycleFilterValue', () => {
  it('accepts the dropdown values', () => {
    expect(isLifecycleFilterValue('all')).toBe(true);
    expect(isLifecycleFilterValue('draft')).toBe(true);
    expect(isLifecycleFilterValue('live')).toBe(true);
  });

  it('rejects values the dropdown does not offer', () => {
    expect(isLifecycleFilterValue('paused')).toBe(false);
    expect(isLifecycleFilterValue('LIVE')).toBe(false);
    expect(isLifecycleFilterValue('')).toBe(false);
  });
});

describe('parseLifecycleParam', () => {
  it('returns a known value as-is', () => {
    expect(parseLifecycleParam('draft')).toBe('draft');
    expect(parseLifecycleParam('live')).toBe('live');
  });

  it('falls back to "all" for a missing, empty or unknown value', () => {
    expect(parseLifecycleParam(null)).toBe('all');
    expect(parseLifecycleParam('')).toBe('all');
    expect(parseLifecycleParam('bogus')).toBe('all');
    expect(parseLifecycleParam('account_only')).toBe('all');
  });
});

describe('lifecycleQuery', () => {
  it('sends draft and live, and nothing for "all"', () => {
    expect(lifecycleQuery('draft')).toEqual({ lifecycle: 'draft' });
    expect(lifecycleQuery('live')).toEqual({ lifecycle: 'live' });
    expect(lifecycleQuery('all')).toEqual({});
  });
});

describe('filterRowsByLifecycle', () => {
  const rows = [
    { id: 'a', lifecycle_status: 'draft' as const },
    { id: 'b', lifecycle_status: 'live' as const },
    { id: 'c' },
    { id: 'd', lifecycle_status: 'paused' as const },
  ];

  it('returns every row for "all"', () => {
    expect(filterRowsByLifecycle(rows, 'all')).toBe(rows);
  });

  it('counts a row without lifecycle_status as live', () => {
    expect(filterRowsByLifecycle(rows, 'live').map((r) => r.id)).toEqual(['b', 'c']);
    expect(filterRowsByLifecycle(rows, 'draft').map((r) => r.id)).toEqual(['a']);
  });

  it('returns an empty list for no rows', () => {
    expect(filterRowsByLifecycle([], 'draft')).toEqual([]);
  });
});
