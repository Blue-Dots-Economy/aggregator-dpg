import { describe, it, expect } from 'vitest';
import { normalisePhone } from './phone.js';

describe('normalisePhone', () => {
  it('keeps already-canonical E.164', () => {
    expect(normalisePhone('+919876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('strips spaces and dashes', () => {
    expect(normalisePhone('+91 98765 43210')).toEqual({
      ok: true,
      value: '+919876543210',
    });
    expect(normalisePhone('+91-9876-543-210')).toEqual({
      ok: true,
      value: '+919876543210',
    });
  });

  it('prefixes +91 to bare 10-digit Indian numbers', () => {
    expect(normalisePhone('9876543210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('keeps 11–15 digit non-prefixed numbers as international', () => {
    expect(normalisePhone('919876543210')).toEqual({
      ok: true,
      value: '+919876543210',
    });
  });

  it('rejects empty input', () => {
    const r = normalisePhone('');
    expect(r.ok).toBe(false);
  });

  it('rejects too-short numbers', () => {
    const r = normalisePhone('12345');
    expect(r.ok).toBe(false);
  });

  it('rejects too-long numbers', () => {
    const r = normalisePhone('+1234567890123456');
    expect(r.ok).toBe(false);
  });

  it('rejects letters', () => {
    const r = normalisePhone('abc');
    expect(r.ok).toBe(false);
  });
});
