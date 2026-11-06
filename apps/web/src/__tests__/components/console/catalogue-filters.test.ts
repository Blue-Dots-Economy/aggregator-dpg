import { describe, it, expect } from 'vitest';
import {
  areaLabel,
  areaOf,
  groupByArea,
  matches,
} from '@/components/console/access/catalogue-filters';

describe('catalogue-filters', () => {
  it('matches any field by lower-cased substring, and everything for an empty query', () => {
    expect(matches('', 'anything')).toBe(true);
    expect(matches('pii', 'Profiles', 'PII Access')).toBe(true);
    expect(matches('nope', 'Profiles')).toBe(false);
  });

  it('reads the area before the first dot', () => {
    expect(areaOf('profiles.view_pii')).toBe('profiles');
    expect(areaOf('plain')).toBe('plain');
  });

  it('groups by area in first-seen order', () => {
    const grouped = groupByArea(['org.manage', 'profiles.view', 'org.read'], (k) => k);
    expect([...grouped.entries()]).toEqual([
      ['org', ['org.manage', 'org.read']],
      ['profiles', ['profiles.view']],
    ]);
  });

  it('turns an area into a heading', () => {
    expect(areaLabel('known_as')).toBe('Known as');
  });
});
