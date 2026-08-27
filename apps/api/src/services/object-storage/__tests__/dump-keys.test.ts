/**
 * Tests for non-PII dump key derivation. Pure logic, no S3 — the "no fallback,
 * a wrong root must 404 rather than serve something else" rule is enforced by
 * these keys being exactly what the exporter writes and nothing more.
 *
 * @module apps/api/services/object-storage/__tests__/dump-keys.test
 */
import { describe, it, expect } from 'vitest';
import { DUMP_TABLES, dumpKeyRoot, dumpObjectKeys } from '../dump-keys.js';

describe('dumpKeyRoot', () => {
  it('omits an empty prefix so keys start at the network segment', () => {
    expect(dumpKeyRoot({ prefix: '', network: 'blue_dot', instanceId: 'blue_dot_up' })).toBe(
      'blue_dot/blue_dot_up',
    );
  });

  it('includes a configured prefix', () => {
    expect(
      dumpKeyRoot({ prefix: 'signals-dumps', network: 'blue_dot', instanceId: 'blue_dot_up' }),
    ).toBe('signals-dumps/blue_dot/blue_dot_up');
  });

  it('normalises surrounding slashes on the prefix', () => {
    expect(
      dumpKeyRoot({ prefix: '/signals-dumps/', network: 'blue_dot', instanceId: 'blue_dot_up' }),
    ).toBe('signals-dumps/blue_dot/blue_dot_up');
  });

  it('collapses repeated slashes rather than emitting an empty key segment', () => {
    expect(
      dumpKeyRoot({ prefix: '//signals//dumps//', network: 'blue_dot', instanceId: 'blue_dot_up' }),
    ).toBe('signals/dumps/blue_dot/blue_dot_up');
  });

  it('reduces a prefix of only slashes to nothing', () => {
    expect(
      dumpKeyRoot({ prefix: '/'.repeat(1_000), network: 'blue_dot', instanceId: 'blue_dot_up' }),
    ).toBe('blue_dot/blue_dot_up');
  });
});

describe('dumpObjectKeys', () => {
  it('returns the three tables in the exporter order', () => {
    const keys = dumpObjectKeys({ prefix: '', network: 'blue_dot', instanceId: 'blue_dot_up' });
    expect(keys).toEqual([
      { table: 'user', key: 'blue_dot/blue_dot_up/user.ndjson.gz' },
      { table: 'items', key: 'blue_dot/blue_dot_up/items.ndjson.gz' },
      { table: 'item_actions', key: 'blue_dot/blue_dot_up/item_actions.ndjson.gz' },
    ]);
  });

  it('covers every declared table', () => {
    const keys = dumpObjectKeys({ prefix: '', network: 'n', instanceId: 'i' });
    expect(keys.map((k) => k.table)).toEqual([...DUMP_TABLES]);
  });
});
