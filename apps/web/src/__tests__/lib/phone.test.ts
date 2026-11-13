/**
 * Unit tests for the web phone helpers: a country code from the deployment's
 * `PHONE_COUNTRIES` (India when unset), stored as `+<code><number>`.
 */
import { describe, it, expect } from 'vitest';
import {
  acceptsListedPhone,
  DEFAULT_PHONE_COUNTRIES,
  isAcceptedPhone,
  isPhoneFieldName,
  isValidPhone,
  joinPhone,
  nationalFromInput,
  nationalMaxLength,
  parsePhoneCountries,
  phoneValueMode,
  splitPhone,
} from '@/lib/phone';

describe('phone helpers', () => {
  it('accepts an Indian mobile with or without +91, and nothing longer', () => {
    expect(isValidPhone('+919876543210')).toBe(true);
    expect(isValidPhone('9876543210')).toBe(true);
    expect(isValidPhone('+9198765432101')).toBe(false);
    expect(isValidPhone('+915876543210')).toBe(false);
    expect(isValidPhone('12345')).toBe(false);
  });

  it('accepts another country code only as the server does (10-15 digits after +)', () => {
    expect(isValidPhone('+447911123456')).toBe(true);
    expect(isValidPhone('+65912345')).toBe(false);
    expect(isValidPhone('+4479111234567890')).toBe(false);
  });

  it('treats only real phone field names as phone fields', () => {
    for (const name of [
      'phone',
      'contact_phone',
      'mobile_number',
      'contactPhoneNumber',
      'Phone Number',
      'hiringManagerPhoneNumber',
    ]) {
      expect(isPhoneFieldName(name)).toBe(true);
    }
    for (const name of [
      'phone_model',
      'mobile_app_name',
      'automobile_type',
      'automobile',
      'phoneVerified',
    ]) {
      expect(isPhoneFieldName(name)).toBe(false);
    }
  });

  it('stores the bare number when the field pattern takes no country code', () => {
    expect(phoneValueMode('^[0-9]{10}$')).toBe('national');
    expect(phoneValueMode('^(\\+?\\d{10,15}|\\d{10})$')).toBe('international');
    expect(phoneValueMode(undefined)).toBe('international');
    expect(phoneValueMode('(')).toBe('international');
  });

  it('keeps +91 for partial values and strips a pasted code or trunk 0', () => {
    expect(splitPhone('+91987')).toEqual({ code: '+91', national: '987' });
    expect(splitPhone('919876543210')).toEqual({ code: '+91', national: '9876543210' });
    expect(nationalFromInput('919876543210', '+91').national).toBe('9876543210');
    expect(nationalFromInput('098765 43210', '+91').national).toBe('9876543210');
  });

  it('offers India only, and keeps a pasted unlisted code as digits so it fails validation', () => {
    expect(DEFAULT_PHONE_COUNTRIES.map((c) => c.code)).toEqual(['+91']);
    expect(nationalFromInput('+91 98765 43210', '+91')).toEqual({
      code: '+91',
      national: '9876543210',
    });
    expect(nationalFromInput('+61 412 345 678', '+91')).toEqual({
      code: '+91',
      national: '61412345678',
    });
    expect(isValidPhone('+9161412345678')).toBe(false);
  });

  it('accepts any server-valid number for optional contact fields', () => {
    expect(isAcceptedPhone('+914012345678')).toBe(true);
    expect(isAcceptedPhone('12345')).toBe(false);
  });

  it('refuses a contact number whose first digit after +91 is 0', () => {
    for (const v of ['+910000000000', '0000000000', '0123456789']) {
      expect(isAcceptedPhone(v)).toBe(false);
    }
    expect(isAcceptedPhone('080 1234 5678')).toBe(true);
  });

  it('splits a stored value, reading a bare 10-digit value as +91', () => {
    expect(splitPhone('+919876543210')).toEqual({ code: '+91', national: '9876543210' });
    expect(splitPhone('9876543210')).toEqual({ code: '+91', national: '9876543210' });
    expect(splitPhone(undefined)).toEqual({ code: '+91', national: '' });
    expect(splitPhone('09876543210')).toEqual({ code: '+91', national: '9876543210' });
  });

  it('joins code and number, and limits the number to 10 digits for +91', () => {
    expect(joinPhone('+91', '98765 43210')).toBe('+919876543210');
    expect(joinPhone('+91', '')).toBeUndefined();
    expect(nationalMaxLength('+91')).toBe(10);
    expect(nationalMaxLength('+44')).toBe(13);
  });

  it('gives the phone box only to fields whose pattern accepts a listed number', () => {
    expect(acceptsListedPhone('^(\\+91[6-9][0-9]{9}|[6-9][0-9]{9})$')).toBe(true);
    expect(acceptsListedPhone('^[0-9]{10}$')).toBe(true);
    expect(acceptsListedPhone(undefined)).toBe(false);
    expect(acceptsListedPhone('^[a-z]+$')).toBe(false);
    const gbOnly = '^\\+44[0-9]{10}$';
    expect(acceptsListedPhone(gbOnly)).toBe(false);
    expect(acceptsListedPhone(gbOnly, parsePhoneCountries('IN:+91,GB:+44'))).toBe(true);
  });

  it('reads the country list from config: India by default, first entry is the default', () => {
    expect(parsePhoneCountries(undefined)).toEqual(DEFAULT_PHONE_COUNTRIES);
    expect(parsePhoneCountries('')).toEqual(DEFAULT_PHONE_COUNTRIES);
    expect(parsePhoneCountries('junk, X:+1')).toEqual(DEFAULT_PHONE_COUNTRIES);
    const list = parsePhoneCountries(' gb:44 , IN:+91, US:+1, CA:+1, bad, FR:+33');
    expect(list.map((c) => `${c.iso}${c.code}`)).toEqual(['GB+44', 'IN+91', 'US+1', 'FR+33']);
    expect(list[0].flag).toBe('🇬🇧');
    expect(nationalMaxLength('+44', list)).toBe(10);
    expect(nationalMaxLength('+33', list)).toBe(13);
  });

  it('splits and reads numbers for a configured country', () => {
    const list = parsePhoneCountries('IN:+91,GB:+44');
    expect(splitPhone('+447911123456', list)).toEqual({ code: '+44', national: '7911123456' });
    expect(splitPhone('9876543210', list)).toEqual({ code: '+91', national: '9876543210' });
    expect(nationalFromInput('+44 7911 123456', '+91', list)).toEqual({
      code: '+44',
      national: '7911123456',
    });
    expect(phoneValueMode('^\\+44[0-9]{10}$', list)).toBe('international');
  });

  it('checks a mobile exactly as the server does, a trunk 0 included', () => {
    expect(isValidPhone('09876543210')).toBe(true);
    expect(isValidPhone('+912234567890')).toBe(false);
    expect(isAcceptedPhone('+912234567890')).toBe(true);
  });
});
