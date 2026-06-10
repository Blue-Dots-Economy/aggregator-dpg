import { describe, it, expect } from 'vitest';
import { mapDirectional } from '../row-mapping';

describe('mapDirectional', () => {
  it('reads a directional action map with zero fallback for absent buckets', () => {
    expect(mapDirectional({ create: 2, accept: 1 })).toEqual({
      create: 2,
      accept: 1,
      reject: 0,
      cancel: 0,
    });
  });

  it('returns all-zero for a missing map', () => {
    expect(mapDirectional(undefined)).toEqual({ create: 0, accept: 0, reject: 0, cancel: 0 });
  });

  it('ignores non-numeric values', () => {
    expect(mapDirectional({ create: '5', accept: null, reject: 3 })).toEqual({
      create: 0,
      accept: 0,
      reject: 3,
      cancel: 0,
    });
  });
});
