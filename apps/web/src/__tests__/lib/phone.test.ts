/**
 * Unit tests for the web phone helpers: an editable country code defaulting to
 * +91, stored as `+<code><number>`.
 */
import { describe, it, expect } from 'vitest';
import {
  isAcceptedPhone,
  isPhoneFieldName,
  isValidPhone,
  joinPhone,
  nationalFromInput,
  nationalMaxLength,
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

  it('accepts any server-valid number for optional contact fields', () => {
    expect(isAcceptedPhone('+914012345678')).toBe(true);
    expect(isAcceptedPhone('12345')).toBe(false);
  });

  it('splits a stored value, reading a bare 10-digit value as +91', () => {
    expect(splitPhone('+919876543210')).toEqual({ code: '+91', national: '9876543210' });
    expect(splitPhone('9876543210')).toEqual({ code: '+91', national: '9876543210' });
    expect(splitPhone(undefined)).toEqual({ code: '+91', national: '' });
  });

  it('joins code and number, and limits the number to 10 digits for +91', () => {
    expect(joinPhone('+91', '98765 43210')).toBe('+919876543210');
    expect(joinPhone('+91', '')).toBeUndefined();
    expect(nationalMaxLength('+91')).toBe(10);
    expect(nationalMaxLength('+44')).toBe(13);
  });
});
