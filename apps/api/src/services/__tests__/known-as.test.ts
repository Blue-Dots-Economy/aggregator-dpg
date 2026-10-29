/**
 * Unit tests for the "known as" level helpers.
 *
 * Covers: the level and label of a key (configured or not), the value a new
 * org gets under a parent (one value one level down, several, none, unknown
 * parent level), and the levels in order.
 */
import { describe, expect, it } from 'vitest';
import type { KnownAsConfig } from '@aggregator-dpg/network-config/interface';
import { childKnownAs, labelOf, levelOf, levelsOf, NETWORK_LEVEL } from '../known-as.js';

const cfg: KnownAsConfig = {
  values: [
    { key: 'state', label: 'State', level: 1 },
    { key: 'district', label: 'District', level: 2 },
    { key: 'aggregator', label: 'Aggregator', level: 3 },
    { key: 'training_partner', label: 'Training Partner', level: 3 },
  ],
  default: 'aggregator',
};

describe('levelOf / labelOf', () => {
  it('reads a configured value', () => {
    expect(levelOf(cfg, 'district')).toBe(2);
    expect(labelOf(cfg, 'district')).toBe('District');
  });

  it('gives null for a key that is not configured', () => {
    expect(levelOf(cfg, 'gone')).toBeNull();
    expect(labelOf(cfg, 'gone')).toBeNull();
  });
});

describe('childKnownAs', () => {
  it('picks the only value one level below the parent', () => {
    expect(childKnownAs(cfg, NETWORK_LEVEL)).toBe('state');
    expect(childKnownAs(cfg, 1)).toBe('district');
  });

  it('uses the default when several values sit one level below', () => {
    const many = { ...cfg, default: 'training_partner' };
    expect(childKnownAs(many, 2)).toBe('training_partner');
  });

  it('uses the default below the deepest level and for an unknown parent level', () => {
    expect(childKnownAs(cfg, 3)).toBe('aggregator');
    expect(childKnownAs(cfg, null)).toBe('aggregator');
  });
});

describe('levelsOf', () => {
  it('lists each level in order with its values', () => {
    expect(levelsOf(cfg)).toEqual([
      { level: 1, values: [{ key: 'state', label: 'State' }] },
      { level: 2, values: [{ key: 'district', label: 'District' }] },
      {
        level: 3,
        values: [
          { key: 'aggregator', label: 'Aggregator' },
          { key: 'training_partner', label: 'Training Partner' },
        ],
      },
    ]);
  });
});
