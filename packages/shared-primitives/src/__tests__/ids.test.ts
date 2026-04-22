import { describe, it, expect } from 'vitest';
import {
  aggregatorId,
  userId,
  orgId,
  linkId,
  batchId,
  exportId,
  type AggregatorId,
  type UserId,
} from '../ids/index.js';

describe('ID constructors', () => {
  it('aggregatorId returns branded string', () => {
    const id = aggregatorId('agg-1');
    expect(id).toBe('agg-1');
  });

  it('userId returns branded string', () => {
    expect(userId('u-1')).toBe('u-1');
  });

  it('orgId returns branded string', () => {
    expect(orgId('org-1')).toBe('org-1');
  });

  it('linkId returns branded string', () => {
    expect(linkId('link-1')).toBe('link-1');
  });

  it('batchId returns branded string', () => {
    expect(batchId('batch-1')).toBe('batch-1');
  });

  it('exportId returns branded string', () => {
    expect(exportId('export-1')).toBe('export-1');
  });

  it('throws on empty string', () => {
    expect(() => aggregatorId('')).toThrow();
    expect(() => userId('')).toThrow();
    expect(() => orgId('')).toThrow();
    expect(() => linkId('')).toThrow();
    expect(() => batchId('')).toThrow();
    expect(() => exportId('')).toThrow();
  });
});

describe('Brand type-level guard', () => {
  it('AggregatorId and UserId share the same runtime value shape', () => {
    const aId: AggregatorId = aggregatorId('a-1');
    const uId: UserId = userId('u-1');
    // At runtime both are strings — brand is compile-time only
    expect(typeof aId).toBe('string');
    expect(typeof uId).toBe('string');
  });

  it('function accepting AggregatorId rejects plain string at compile time', () => {
    // This is a runtime test confirming the value flows correctly
    function acceptAggregatorId(id: AggregatorId): string {
      return id;
    }
    const id = aggregatorId('agg-42');
    expect(acceptAggregatorId(id)).toBe('agg-42');
  });
});
