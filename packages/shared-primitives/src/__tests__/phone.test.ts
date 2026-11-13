/**
 * Tests for the shared contact-detail normalisers.
 *
 * Merges the two suites that previously sat beside the duplicated copies in
 * `apps/api/src/services/phone.test.ts` and
 * `apps/worker/src/services/phone.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  normalisePhone,
  normaliseContactPhone,
  normaliseEmail,
  isEmailAddress,
} from '../phone/index.js';

describe('normalisePhone', () => {
  it('keeps already-canonical E.164', () => {
    expect(normalisePhone('+919876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('strips spaces and dashes', () => {
    expect(normalisePhone('+91 98765 43210')).toEqual({ ok: true, value: '+919876543210' });
    expect(normalisePhone('+91-9876-543-210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('strips surrounding whitespace', () => {
    expect(normalisePhone('  +919876543210  ')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('prefixes +91 to bare 10-digit Indian numbers', () => {
    expect(normalisePhone('9876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('keeps 11-15 digit non-prefixed numbers as international', () => {
    expect(normalisePhone('919876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('accepts the 15-digit upper bound', () => {
    expect(normalisePhone('123456789012345')).toEqual({ ok: true, value: '+123456789012345' });
    expect(normalisePhone('+123456789012345')).toEqual({ ok: true, value: '+123456789012345' });
  });

  it('rejects empty input', () => {
    expect(normalisePhone('')).toEqual({ ok: false, error: { message: 'phone is empty' } });
  });

  it('rejects too-short numbers', () => {
    const r = normalisePhone('12345');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/expected 10-15/);
  });

  it('rejects too-long numbers', () => {
    const r = normalisePhone('+1234567890123456');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/10-15 digits after country code/);
  });

  it('needs a 10-digit mobile starting 6-9 after +91', () => {
    for (const raw of [
      '+91935350600',
      '+9193535060012',
      '91935350600',
      '+911234567890',
      '+912234567890',
    ]) {
      const r = normalisePhone(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/10-digit mobile number starting 6-9/);
    }
    expect(normalisePhone('+447911123456')).toEqual({ ok: true, value: '+447911123456' });
  });

  it('drops a trunk 0 and reads 91 and 10 digits as +91', () => {
    expect(normalisePhone('09876543210')).toEqual({ ok: true, value: '+919876543210' });
    expect(normalisePhone('919876543210')).toEqual({ ok: true, value: '+919876543210' });
    expect(normalisePhone('+09876543210').ok).toBe(false);
  });

  it('says a number cannot start with 0 after the +', () => {
    expect(normalisePhone('+09876543210')).toEqual({
      ok: false,
      error: { message: 'phone cannot start with 0 after the +' },
    });
    expect(normalisePhone('012345678')).toEqual({
      ok: false,
      error: { message: 'phone has 9 digits; expected 10-15' },
    });
  });

  it('rejects a too-short number that carries a country-code prefix', () => {
    const r = normalisePhone('+12345');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/10-15 digits after country code/);
  });

  it('rejects letters', () => {
    expect(normalisePhone('abc').ok).toBe(false);
  });

  it('rejects punctuation-only input, reporting zero digits', () => {
    const r = normalisePhone('---');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/phone has 0 digits/);
  });
});

describe('normaliseContactPhone', () => {
  it('accepts an Indian landline and a mobile, each with 10 digits after +91', () => {
    expect(normaliseContactPhone('+918023456789')).toEqual({ ok: true, value: '+918023456789' });
    expect(normaliseContactPhone('011 2345 6789')).toEqual({ ok: true, value: '+911123456789' });
    expect(normaliseContactPhone('09876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('rejects a +91 number that is not 10 digits', () => {
    const r = normaliseContactPhone('+91935350600');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/10 digits after the country code/);
  });

  it('refuses a +91 number whose first digit is 0', () => {
    for (const raw of ['+910000000000', '0123456789', '+910123456789']) {
      const r = normaliseContactPhone(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/not starting with 0/);
    }
    // A leading 00 is the international prefix, so this reads as `+00000000`.
    expect(normaliseContactPhone('0000000000')).toEqual({
      ok: false,
      error: { message: 'phone cannot start with 0 after the 00' },
    });
  });

  it('reads a leading 00 as + for a contact number', () => {
    expect(normaliseContactPhone('00 44 7911 123456')).toEqual({
      ok: true,
      value: '+447911123456',
    });
  });
});

describe('normaliseEmail', () => {
  it('trims and lower-cases', () => {
    expect(normaliseEmail('  Asha@Example.COM  ')).toBe('asha@example.com');
  });

  it('returns null for undefined', () => {
    expect(normaliseEmail(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(normaliseEmail(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(normaliseEmail('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(normaliseEmail('   ')).toBeNull();
  });

  it('leaves an already-normalised address untouched', () => {
    expect(normaliseEmail('ravi@x.io')).toBe('ravi@x.io');
  });
});

describe('isEmailAddress', () => {
  it('accepts a plain address and a sub-domain', () => {
    expect(isEmailAddress('asha@example.org')).toBe(true);
    expect(isEmailAddress('a.b+c@mail.example.co.in')).toBe(true);
  });

  it('rejects text without a dotted domain', () => {
    expect(isEmailAddress('not-an-email')).toBe(false);
    expect(isEmailAddress('asha@example')).toBe(false);
    expect(isEmailAddress('asha@.org')).toBe(false);
  });

  it('rejects spaces and a second @', () => {
    expect(isEmailAddress('asha @example.org')).toBe(false);
    expect(isEmailAddress('a@b@example.org')).toBe(false);
  });
});
