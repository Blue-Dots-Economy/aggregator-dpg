/**
 * Tests for the shared email helpers. Phone checks are tested in `phone-parse.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { normaliseEmail, isEmailAddress } from '../phone/index.js';

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
