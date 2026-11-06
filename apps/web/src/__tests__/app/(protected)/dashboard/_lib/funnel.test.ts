import { describe, it, expect } from 'vitest';
import {
  actionTotal,
  buildActionParts,
  getBucketLabel,
} from '@/app/(protected)/dashboard/_lib/funnel';

describe('getBucketLabel', () => {
  it('prefers config, then the fallback, then the key', () => {
    expect(getBucketLabel({ create: 'Asked' }, 'create', () => 'Created')).toBe('Asked');
    expect(getBucketLabel({}, 'create', () => 'Created')).toBe('Created');
    expect(getBucketLabel({}, 'create')).toBe('create');
  });
});

describe('buildActionParts', () => {
  it('returns the four buckets in order with their counts and labels', () => {
    const parts = buildActionParts(
      { create: 1, accept: 2, reject: 3, cancel: 4 },
      { accept: 'Hired' },
      (k) => `fb-${k}`,
    );
    expect(parts.map((p) => [p.v, p.label])).toEqual([
      [1, 'fb-create'],
      [2, 'Hired'],
      [3, 'fb-reject'],
      [4, 'fb-cancel'],
    ]);
    expect(new Set(parts.map((p) => p.color)).size).toBe(4);
  });
});

describe('actionTotal', () => {
  it('sums the four buckets', () => {
    expect(actionTotal({ create: 1, accept: 2, reject: 3, cancel: 4 })).toBe(10);
    expect(actionTotal({ create: 0, accept: 0, reject: 0, cancel: 0 })).toBe(0);
  });
});
