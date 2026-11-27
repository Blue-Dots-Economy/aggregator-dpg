/**
 * Tests for the api's phone checks, run with the default `PHONE_COUNTRIES` (India).
 */

import { describe, it, expect } from 'vitest';
import { parseContactPhone, parseMobilePhone } from './phone.js';

describe('parseMobilePhone', () => {
  it('normalises an Indian mobile in any spacing', () => {
    expect(parseMobilePhone('+91 98765 43210')).toEqual({ ok: true, value: '+919876543210' });
  });

  it('refuses a landline (Delhi 011)', () => {
    expect(parseMobilePhone('+911123456789')).toMatchObject({
      ok: false,
      error: { reason: 'not_mobile' },
    });
  });

  it('refuses a country outside PHONE_COUNTRIES', () => {
    expect(parseMobilePhone('+447911123456')).toMatchObject({
      ok: false,
      error: { reason: 'country_not_allowed' },
    });
  });
});

describe('parseContactPhone', () => {
  it('takes a landline', () => {
    expect(parseContactPhone('011 2345 6789')).toEqual({ ok: true, value: '+911123456789' });
  });
});
