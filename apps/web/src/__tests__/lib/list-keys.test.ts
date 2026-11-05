/**
 * Unit tests for `withStableKeys`.
 *
 * Covers: keys built from each item's own fields, a suffix for repeated keys,
 * keys that do not change when other items are removed, and an empty list.
 */
import { describe, it, expect } from 'vitest';
import { withStableKeys } from '@/lib/list-keys';

describe('withStableKeys', () => {
  it('keys each item by the value the caller derives from it', () => {
    expect(withStableKeys(['a', 'b'], (s) => s)).toEqual([
      { item: 'a', key: 'a' },
      { item: 'b', key: 'b' },
    ]);
  });

  it('adds a suffix to a repeated key so every key is unique', () => {
    const keys = withStableKeys(['a', 'b', 'a', 'a'], (s) => s).map((k) => k.key);
    expect(keys).toEqual(['a', 'b', 'a#2', 'a#3']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('skips a suffix that another item already has as its own key', () => {
    const keys = withStableKeys(['Unit', 'Unit', 'Unit#2'], (s) => s).map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice(0, 2)).toEqual(['Unit', 'Unit#2']);

    const reversed = withStableKeys(['Unit#2', 'Unit', 'Unit'], (s) => s).map((k) => k.key);
    expect(reversed).toEqual(['Unit#2', 'Unit', 'Unit#3']);
  });

  it('keeps an item key when an item before it is removed', () => {
    const before = withStableKeys(['a', 'b', 'c'], (s) => s);
    const after = withStableKeys(['b', 'c'], (s) => s);
    expect(after.map((k) => k.key)).toEqual(before.slice(1).map((k) => k.key));
  });

  it('returns an empty list for no items', () => {
    expect(withStableKeys([], (s: string) => s)).toEqual([]);
  });
});
