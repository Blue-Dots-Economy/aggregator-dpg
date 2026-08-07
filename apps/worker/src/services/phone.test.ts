/**
 * Unit tests for worker-side phone/email normalisation. Ported from
 * `apps/api/src/services/phone.test.ts` (this file is an intentional copy —
 * see the module header) plus coverage for `normaliseEmail`, which the API
 * copy doesn't export.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect } from 'vitest';
import { normalisePhone, normaliseEmail } from './phone.js';

describe('normalisePhone', () => {
  it('keeps already-canonical E.164', () => {
    expect(normalisePhone('+919876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('strips spaces and dashes', () => {
    expect(normalisePhone('+91 98765 43210')).toEqual({ ok: true, value: '+919876543210' });
    expect(normalisePhone('+91-9876-543-210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('prefixes +91 to bare 10-digit Indian numbers', () => {
    expect(normalisePhone('9876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('keeps 11-15 digit non-prefixed numbers as international', () => {
    expect(normalisePhone('919876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('rejects empty input', () => {
    expect(normalisePhone('')).toEqual({ ok: false, error: { message: 'phone is empty' } });
  });

  it('rejects whitespace-only input as too short after cleaning', () => {
    const r = normalisePhone('   ');
    expect(r.ok).toBe(false);
  });

  it('rejects too-short numbers', () => {
    const r = normalisePhone('12345');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/expected 10-15/);
  });

  it('rejects too-long bare numbers (>15 digits)', () => {
    const r = normalisePhone('1234567890123456');
    expect(r.ok).toBe(false);
  });

  it('rejects too-long +-prefixed numbers (>15 digits after the country code)', () => {
    const r = normalisePhone('+1234567890123456');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/10-15 digits after country code/);
  });

  it('rejects too-short +-prefixed numbers (<10 digits after the country code)', () => {
    const r = normalisePhone('+123456789');
    expect(r.ok).toBe(false);
  });

  it('rejects letters', () => {
    const r = normalisePhone('abc');
    expect(r.ok).toBe(false);
  });

  it('accepts the boundary 15-digit bare number', () => {
    const r = normalisePhone('123456789012345');
    expect(r).toEqual({ ok: true, value: '+123456789012345' });
  });
});

describe('normaliseEmail', () => {
  it('lowercases and trims a well-formed email', () => {
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

  it('returns null for a whitespace-only string', () => {
    expect(normaliseEmail('   ')).toBeNull();
  });

  it('leaves an already-lowercase, trimmed email unchanged', () => {
    expect(normaliseEmail('ravi@x.io')).toBe('ravi@x.io');
  });
});
