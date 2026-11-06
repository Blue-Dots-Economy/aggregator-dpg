import { describe, it, expect } from 'vitest';
import {
  buildStatusOptions,
  indexStatusRules,
  statusLabel,
} from '@/app/(protected)/dashboard/_lib/status';

describe('statusLabel', () => {
  it('title-cases snake and kebab keys', () => {
    expect(statusLabel('at_risk')).toBe('At Risk');
    expect(statusLabel('long--gone_now')).toBe('Long Gone Now');
    expect(statusLabel('')).toBe('');
  });
});

describe('buildStatusOptions', () => {
  it('starts with the "all" option and lists each status with its count', () => {
    expect(buildStatusOptions({ new: 2, at_risk: 1, '': 9 }, 'Any status')).toEqual([
      { value: 'all', label: 'Any status' },
      { value: 'new', label: 'New', count: 2 },
      { value: 'at_risk', label: 'At Risk', count: 1 },
    ]);
  });

  it('returns only "all" without counts', () => {
    expect(buildStatusOptions(undefined, 'Any')).toEqual([{ value: 'all', label: 'Any' }]);
  });
});

describe('indexStatusRules', () => {
  it('indexes label and description by status, leaving out missing ones', () => {
    expect(
      indexStatusRules([
        { status: 'new', label: 'Fresh' },
        { status: 'at_risk', description: 'Slow' },
      ]),
    ).toEqual({ new: { label: 'Fresh' }, at_risk: { description: 'Slow' } });
  });

  it('returns an empty map without rules', () => {
    expect(indexStatusRules(undefined)).toEqual({});
  });
});
