/**
 * Phone numbers in the web forms (`apps/web`): a country code that defaults to
 * India plus a national number, stored together as `+<code><number>`.
 *
 * @module apps/web/src/lib/phone
 */

import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';

/** Country code a phone field starts with. */
export const DEFAULT_DIAL_CODE = '+91';

/** National digits allowed for India; E.164 caps a whole number at 15 digits. */
const INDIA_NATIONAL_DIGITS = 10;
const MAX_TOTAL_DIGITS = 15;

/** Name words that mark a phone field; a trailing "number"/"no" is allowed after them. */
const PHONE_WORDS = new Set(['phone', 'mobile']);
const NUMBER_WORDS = new Set(['number', 'no', 'num']);

/** A country code and the number typed after it. */
export interface PhoneParts {
  code: string;
  national: string;
}

/** Splits `contactPhoneNumber`, `mobile_number` or `Phone Number` into lower-case words. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * True when a field name ends in a phone word (`phone`, `contact_phone`,
 * `mobileNumber`, `Phone Number`); `phone_model` or `automobile` do not count.
 */
export function isPhoneFieldName(name: string | undefined): boolean {
  if (!name) return false;
  const words = nameWords(name);
  const last = words.at(-1) ?? '';
  const beforeLast = words.at(-2) ?? '';
  return PHONE_WORDS.has(last) || (NUMBER_WORDS.has(last) && PHONE_WORDS.has(beforeLast));
}

/**
 * How a phone field stores its value, read from its schema `pattern`: with
 * the country code (`+91…`), or as the bare national number when the pattern
 * only accepts that (e.g. `^[0-9]{10}$` on networks that store 10 digits).
 */
export function phoneValueMode(pattern: unknown): 'international' | 'national' {
  if (typeof pattern !== 'string') return 'international';
  try {
    const re = new RegExp(pattern);
    if (re.test('+919876543210')) return 'international';
    return re.test('9876543210') ? 'national' : 'international';
  } catch {
    return 'international';
  }
}

/** Keeps `+` and up to three digits, so the code box always reads `+NNN`. */
export function sanitizeDialCode(raw: string): string {
  return `+${raw.replace(/\D/g, '').slice(0, 3)}`;
}

/** Most national digits the number box accepts after `code`. */
export function nationalMaxLength(code: string): number {
  const codeDigits = code.replace(/\D/g, '').length;
  return code === DEFAULT_DIAL_CODE ? INDIA_NATIONAL_DIGITS : MAX_TOTAL_DIGITS - codeDigits;
}

/**
 * Splits a stored value into code and number. A bare 10-digit value is read as
 * an Indian number, and `+91…` always as India.
 */
export function splitPhone(value: string | undefined | null): PhoneParts {
  const raw = (value ?? '').replace(/[\s\-()]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    // `919876543210` is the +91 number without its plus.
    if (digits.length === 2 + INDIA_NATIONAL_DIGITS && digits.startsWith('91')) {
      return { code: DEFAULT_DIAL_CODE, national: digits.slice(2) };
    }
    return { code: DEFAULT_DIAL_CODE, national: digits };
  }
  if (digits.startsWith('91')) return { code: DEFAULT_DIAL_CODE, national: digits.slice(2) };
  // Codes are 1-3 digits; without a country list, keep the last 10 as the number.
  const codeLength = Math.min(3, Math.max(1, digits.length - INDIA_NATIONAL_DIGITS));
  return { code: `+${digits.slice(0, codeLength)}`, national: digits.slice(codeLength) };
}

/**
 * Reads what was typed or pasted into the number box. A full number (`+91 98765
 * 43210`, `919876543210`) or one with a trunk `0` is reduced to its national
 * part instead of being cut short into a different number.
 */
export function nationalFromInput(raw: string, code: string): PhoneParts {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return splitPhone(trimmed);
  let digits = trimmed.replace(/\D/g, '');
  const codeDigits = code.replace(/\D/g, '');
  const max = nationalMaxLength(code);
  if (digits.length > max && codeDigits && digits.startsWith(codeDigits)) {
    digits = digits.slice(codeDigits.length);
  }
  if (digits.length === max + 1 && digits.startsWith('0')) digits = digits.slice(1);
  return { code, national: digits.slice(0, max) };
}

/** Joins code and number for storage; `undefined` when no number was typed. */
export function joinPhone(code: string, national: string): string | undefined {
  const digits = national.replace(/\D/g, '');
  return digits ? `${sanitizeDialCode(code)}${digits}` : undefined;
}

/**
 * True for an Indian mobile (`+91` and 10 digits starting 6-9, or the bare 10
 * digits) or another `+code` number the server's `normalisePhone` accepts.
 */
export function isValidPhone(value: string): boolean {
  const raw = value.replace(/[\s\-()]/g, '');
  if (/^[6-9]\d{9}$/.test(raw)) return true;
  if (!raw.startsWith('+')) return false;
  if (raw.startsWith(DEFAULT_DIAL_CODE)) return /^\+91[6-9]\d{9}$/.test(raw);
  return /^\+[1-9]/.test(raw) && normalisePhone(raw).ok;
}

/** True for any number the server accepts (landlines too); for optional contact fields. */
export function isAcceptedPhone(value: string): boolean {
  return normalisePhone(value).ok;
}
