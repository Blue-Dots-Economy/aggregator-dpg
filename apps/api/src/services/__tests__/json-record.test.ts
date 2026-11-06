import { describe, expect, it } from 'vitest';
import { isRecord, stringItems } from '../json-record.js';

describe('isRecord', () => {
  it('accepts a plain object only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('stringItems', () => {
  it('keeps the string entries of an array', () => {
    expect(stringItems(['a', 1, 'b', null])).toEqual(['a', 'b']);
  });

  it('is empty for anything else', () => {
    expect(stringItems(undefined)).toEqual([]);
    expect(stringItems('a')).toEqual([]);
    expect(stringItems({ 0: 'a' })).toEqual([]);
  });
});
