/**
 * Unit tests for the "known as" helpers.
 *
 * Covers: the value list with the system value first, the name of a key, the
 * depths a value is allowed at (one value at several depths, several values at
 * one depth, the system value everywhere, an unknown key), the suggestion per
 * depth with its fallback, and the store's tree rules.
 */
import { describe, expect, it } from 'vitest';
import type { KnownAsConfig, OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import { isAllowedAt, knownAsValues, nameOf, suggestFor, treeRules } from '../known-as.js';

const cfg: KnownAsConfig = {
  values: [
    { key: 'state', name: 'State', depths: [1] },
    { key: 'district', name: 'District', depths: [1, 2] },
    { key: 'training_partner', name: 'Training Partner' },
  ],
  suggest: [
    { depth: 1, key: 'state' },
    { depth: 2, key: 'district' },
  ],
};

describe('knownAsValues', () => {
  it('lists the system value first, then the instance values', () => {
    expect(knownAsValues(cfg)).toEqual([
      { key: 'aggregator', name: 'Aggregator', depths: null, system: true },
      { key: 'state', name: 'State', depths: [1], system: false },
      { key: 'district', name: 'District', depths: [1, 2], system: false },
      { key: 'training_partner', name: 'Training Partner', depths: null, system: false },
    ]);
  });

  it('lists only the system value when the instance adds none', () => {
    expect(knownAsValues({ values: [], suggest: [] })).toEqual([
      { key: 'aggregator', name: 'Aggregator', depths: null, system: true },
    ]);
  });
});

describe('nameOf', () => {
  it('names the system value and an instance value', () => {
    expect(nameOf(cfg, 'aggregator')).toBe('Aggregator');
    expect(nameOf(cfg, 'district')).toBe('District');
  });

  it('gives null for a key that is not configured', () => {
    expect(nameOf(cfg, 'gone')).toBeNull();
  });
});

describe('isAllowedAt', () => {
  it('allows one value at each of its depths only', () => {
    expect(isAllowedAt(cfg, 'district', 1)).toBe(true);
    expect(isAllowedAt(cfg, 'district', 2)).toBe(true);
    expect(isAllowedAt(cfg, 'district', 3)).toBe(false);
  });

  it('allows several values at one depth', () => {
    expect(['state', 'district', 'training_partner'].map((k) => isAllowedAt(cfg, k, 1))).toEqual([
      true,
      true,
      true,
    ]);
    expect(isAllowedAt(cfg, 'state', 2)).toBe(false);
  });

  it('allows a value with no depths at any depth', () => {
    expect([1, 2, 7].map((d) => isAllowedAt(cfg, 'training_partner', d))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('allows the system value at every depth', () => {
    expect([1, 2, 10].map((d) => isAllowedAt(cfg, 'aggregator', d))).toEqual([true, true, true]);
  });

  it('refuses a key that is not configured', () => {
    expect(isAllowedAt(cfg, 'gone', 1)).toBe(false);
  });
});

describe('suggestFor', () => {
  it('gives the suggestion for a depth', () => {
    expect(suggestFor(cfg, 1)).toBe('state');
    expect(suggestFor(cfg, 2)).toBe('district');
  });

  it('falls back to the system value for a depth with no suggestion', () => {
    expect(suggestFor(cfg, 3)).toBe('aggregator');
    expect(suggestFor({ values: [], suggest: [] }, 1)).toBe('aggregator');
  });
});

describe('treeRules', () => {
  it('reads the limits and the known_as rules from the organisation config', () => {
    const org: OrganisationConfig = {
      hierarchy: { max_depth: 3, max_children: 5, max_total_orgs: 40 },
      known_as: cfg,
    };
    const rules = treeRules(org);
    expect(rules).toMatchObject({ maxDepth: 3, maxChildren: 5, maxTotalOrgs: 40 });
    expect(rules.knownAsAllowed('state', 2)).toBe(false);
    expect(rules.knownAsAllowed('district', 2)).toBe(true);
    expect(rules.suggestFor(1)).toBe('state');
    expect(rules.suggestFor(3)).toBe('aggregator');
    expect(rules.knownAsConfigured('district')).toBe(true);
    expect(rules.knownAsConfigured('aggregator')).toBe(true);
    expect(rules.knownAsConfigured('gone')).toBe(false);
  });

  it('gives a null child limit when max_children is unset', () => {
    const rules = treeRules({
      hierarchy: { max_depth: 1, max_total_orgs: 50 },
      known_as: { values: [], suggest: [] },
    });
    expect(rules).toMatchObject({ maxDepth: 1, maxChildren: null, maxTotalOrgs: 50 });
  });
});
