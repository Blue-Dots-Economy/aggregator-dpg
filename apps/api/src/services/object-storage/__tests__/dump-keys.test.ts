/**
 * Tests for non-PII dump key derivation. Pure logic, no S3 — the "no fallback,
 * a wrong root must 404 rather than serve something else" rule is enforced by
 * these keys being exactly what the exporter writes and nothing more.
 *
 * @module apps/api/services/object-storage/__tests__/dump-keys.test
 */
import { describe, it, expect } from 'vitest';
import { dumpKeyRoot, dumpObjectKeys, dumpTablesSchema } from '../dump-keys.js';

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
  const location = { prefix: '', network: 'blue_dot', instanceId: 'blue_dot_up' };

  it('returns one key per table, in the given order', () => {
    expect(dumpObjectKeys(location, ['user', 'items', 'item_actions'])).toEqual([
      { table: 'user', key: 'blue_dot/blue_dot_up/user.ndjson.gz' },
      { table: 'items', key: 'blue_dot/blue_dot_up/items.ndjson.gz' },
      { table: 'item_actions', key: 'blue_dot/blue_dot_up/item_actions.ndjson.gz' },
    ]);
  });

  it('includes an extra configured table', () => {
    expect(dumpObjectKeys(location, ['user', 'connections']).map((k) => k.key)).toEqual([
      'blue_dot/blue_dot_up/user.ndjson.gz',
      'blue_dot/blue_dot_up/connections.ndjson.gz',
    ]);
  });
});

describe('dumpTablesSchema', () => {
  it('defaults to user, items, item_actions when unset', () => {
    expect(dumpTablesSchema.parse(undefined)).toEqual(['user', 'items', 'item_actions']);
  });

  it('treats a blank value as the default', () => {
    expect(dumpTablesSchema.parse('  ')).toEqual(['user', 'items', 'item_actions']);
  });

  it('parses a custom list and trims whitespace around each name', () => {
    expect(dumpTablesSchema.parse(' user , items,item_actions, connections ')).toEqual([
      'user',
      'items',
      'item_actions',
      'connections',
    ]);
  });

  it.each([
    ['a path segment', 'user,../secret'],
    ['a slash', 'user,a/b'],
    ['a dot', 'user,items.csv'],
    ['an empty entry', 'user,,items'],
    ['a trailing comma', 'user,items,'],
  ])('rejects %s', (_label, value) => {
    expect(dumpTablesSchema.safeParse(value).success).toBe(false);
  });

  it('rejects duplicate table names', () => {
    expect(dumpTablesSchema.safeParse('user,items,user').success).toBe(false);
  });
});
