/**
 * Unit tests for the organisation detail format rules
 * (`@aggregator-dpg/shared-primitives/org-details`): the https-only website
 * rule and the GSTIN format and check character.
 */
import { describe, expect, it } from 'vitest';
import { isValidGstin, isValidWebsite, normaliseGstin } from '../org-details/index.js';

describe('isValidWebsite', () => {
  it.each([
    'https://example.org',
    'https://www.example.org/about?x=1',
    'https://example.org/#team',
    'https://sub.example.co.in',
    'https://my-org.example.org',
    'HTTPS://example.org',
    'https://example.org:8443',
    '  https://example.org  ',
  ])('accepts %s', (value) => {
    expect(isValidWebsite(value)).toBe(true);
  });

  it.each([
    ['a bare domain', 'example.org'],
    ['a www domain without a scheme', 'www.example.org'],
    ['http', 'http://example.org'],
    ['another scheme', 'ftp://example.org'],
    ['a host with no dot', 'https://localhost'],
    ['an IP address', 'https://192.168.1.10'],
    ['a numeric top-level domain', 'https://example.123'],
    ['a one-letter top-level domain', 'https://example.o'],
    ['no host', 'https://'],
    ['a label starting with a hyphen', 'https://-bad.example.org'],
    ['credentials', 'https://user:pass@example.org'],
    ['inner whitespace', 'https://exa mple.org'],
    ['scheme without slashes', 'https:example.org'],
    ['free text', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(isValidWebsite(value)).toBe(false);
  });

  it('stays fast on a long hostile input', () => {
    const value = `https://${'a-'.repeat(5000)}!`;
    const started = Date.now();
    expect(isValidWebsite(value)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('isValidGstin', () => {
  const VALID = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '29ABCDE1234F1ZW'];

  it.each(VALID)('accepts %s', (value) => {
    expect(isValidGstin(value)).toBe(true);
  });

  it('accepts lower case and surrounding spaces', () => {
    expect(isValidGstin('  27aapfu0939f1zv ')).toBe(true);
  });

  it('refuses every single-character change of a valid GSTIN', () => {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const gstin of VALID) {
      for (let i = 0; i < gstin.length; i += 1) {
        for (const c of alphabet) {
          if (c === gstin[i]) continue;
          const changed = gstin.slice(0, i) + c + gstin.slice(i + 1);
          expect(isValidGstin(changed), changed).toBe(false);
        }
      }
    }
  });

  it('refuses two swapped neighbouring characters', () => {
    // PAN digits 0939 → 9039.
    expect(isValidGstin('27AAPFU9039F1ZV')).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['free text', 'hello'],
    ['14 characters', '27AAPFU0939F1Z'],
    ['16 characters', '27AAPFU0939F1ZVX'],
    ['no Z in position 14', '27AAPFU0939F1AV'],
    ['entity number 0', '27AAPFU0939F0ZV'],
    ['letters in the state code', 'AAAAPFU0939F1ZV'],
    ['an invalid check character', '27AAAAA0000A1Z5'],
  ])('refuses %s', (_label, value) => {
    expect(isValidGstin(value)).toBe(false);
  });
});

describe('normaliseGstin', () => {
  it('trims and upper-cases', () => {
    expect(normaliseGstin('  29abcde1234f1zw ')).toBe('29ABCDE1234F1ZW');
  });

  it('keeps an empty value empty', () => {
    expect(normaliseGstin('   ')).toBe('');
  });
});
