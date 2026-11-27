import { describe, it, expect } from 'vitest';
import { isKnownAsEnabled } from '@/lib/known-as-flag';

describe('isKnownAsEnabled', () => {
  it('is off when the variable is unset or blank', () => {
    expect(isKnownAsEnabled({})).toBe(false);
    expect(isKnownAsEnabled({ ORG_KNOWN_AS_ENABLED: '' })).toBe(false);
  });

  it('is on only for "true", ignoring case and spaces', () => {
    expect(isKnownAsEnabled({ ORG_KNOWN_AS_ENABLED: 'true' })).toBe(true);
    expect(isKnownAsEnabled({ ORG_KNOWN_AS_ENABLED: ' TRUE ' })).toBe(true);
  });

  it('is off for any other value', () => {
    for (const v of ['false', '1', 'yes', 'on']) {
      expect(isKnownAsEnabled({ ORG_KNOWN_AS_ENABLED: v })).toBe(false);
    }
  });
});
