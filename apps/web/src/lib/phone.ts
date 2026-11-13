/**
 * Phone numbers in the web forms (`apps/web`): a country code from the
 * deployment's `PHONE_COUNTRIES` (India when unset) plus a national number,
 * stored together as `+<code><number>`. Components get the list from
 * `usePhoneCountries()`; the helpers default to India.
 *
 * @module apps/web/src/lib/phone
 */

import { normaliseContactPhone, normalisePhone } from '@aggregator-dpg/shared-primitives/phone';

/** A country a phone field can use. */
export interface PhoneCountry {
  /** ISO 3166-1 alpha-2 code, e.g. `IN`. */
  iso: string;
  /** Dial code with its plus, e.g. `+91`. */
  code: string;
  flag: string;
  /** Digits in a national number, when known. */
  nationalDigits?: number;
  /** A valid national number, used to test a field's pattern. */
  sample: string;
}

/** The countries a phone field offers; the first is the default. */
export type PhoneCountries = readonly [PhoneCountry, ...PhoneCountry[]];

/** Known national lengths and sample numbers; other countries get the E.164 cap. */
const KNOWN_COUNTRIES: Partial<Record<string, { nationalDigits: number; sample: string }>> = {
  IN: { nationalDigits: 10, sample: '9876543210' },
  GB: { nationalDigits: 10, sample: '7911123456' },
  US: { nationalDigits: 10, sample: '2025550123' },
  CA: { nationalDigits: 10, sample: '4165550123' },
};
const GENERIC_SAMPLE = '2345678901';

const INDIA: PhoneCountry = {
  iso: 'IN',
  code: '+91',
  flag: '🇮🇳',
  nationalDigits: 10,
  sample: '9876543210',
};

/** India only: the list when `PHONE_COUNTRIES` is unset. */
export const DEFAULT_PHONE_COUNTRIES: PhoneCountries = [INDIA];

/** India's dial code: a bare 10-digit number is read as Indian, as the API does. */
export const IN_DIAL_CODE = INDIA.code;

/** National digits allowed for India; E.164 caps a whole number at 15 digits. */
const INDIA_NATIONAL_DIGITS = 10;
const MAX_TOTAL_DIGITS = 15;

function flagOf(iso: string): string {
  return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * Reads the deployment's country list, `IN:+91,GB:+44` (ISO code and dial code,
 * first is the default). Bad or repeated entries are skipped; none left means India.
 */
export function parsePhoneCountries(raw: string | undefined): PhoneCountries {
  const list: PhoneCountry[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const m = /^([A-Za-z]{2})\s*:\s*\+?([1-9]\d{0,2})$/.exec(entry.trim());
    if (!m?.[1] || !m[2]) continue;
    const iso = m[1].toUpperCase();
    const code = `+${m[2]}`;
    if (list.some((c) => c.code === code)) continue;
    list.push({
      iso,
      code,
      flag: flagOf(iso),
      ...(KNOWN_COUNTRIES[iso] ?? { sample: GENERIC_SAMPLE }),
    });
  }
  const [first, ...rest] = list;
  return first ? [first, ...rest] : DEFAULT_PHONE_COUNTRIES;
}

/** The listed country for `code`, if any. */
export function phoneCountry(
  code: string,
  countries: PhoneCountries = DEFAULT_PHONE_COUNTRIES,
): PhoneCountry | undefined {
  return countries.find((c) => c.code === code);
}

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

function patternTest(pattern: unknown): ((v: string) => boolean) | null {
  if (typeof pattern !== 'string') return null;
  try {
    const re = new RegExp(pattern);
    return (v) => re.test(v);
  } catch {
    return null;
  }
}

/**
 * True when a schema `pattern` accepts a number from a listed country, with or
 * without its code. Only such fields get the phone box; a phone-named field with
 * no pattern stays a plain text box, so its number is never rewritten.
 */
export function acceptsListedPhone(
  pattern: unknown,
  countries: PhoneCountries = DEFAULT_PHONE_COUNTRIES,
): boolean {
  const test = patternTest(pattern);
  return !!test && countries.some((c) => test(`${c.code}${c.sample}`) || test(c.sample));
}

/**
 * How a phone field stores its value, read from its schema `pattern`: with the
 * country code (`+91…`), or as the bare number when the pattern only accepts that
 * (e.g. `^[0-9]{10}$` on networks that store 10 digits).
 */
export function phoneValueMode(
  pattern: unknown,
  countries: PhoneCountries = DEFAULT_PHONE_COUNTRIES,
): 'international' | 'national' {
  const test = patternTest(pattern);
  if (!test || countries.some((c) => test(`${c.code}${c.sample}`))) return 'international';
  return countries.some((c) => test(c.sample)) ? 'national' : 'international';
}

/** Most national digits the number box accepts after `code`. */
export function nationalMaxLength(
  code: string,
  countries: PhoneCountries = DEFAULT_PHONE_COUNTRIES,
): number {
  return (
    phoneCountry(code, countries)?.nationalDigits ??
    MAX_TOTAL_DIGITS - code.replace(/\D/g, '').length
  );
}

/**
 * Splits a stored value into code and number. A bare 10-digit value is read as
 * an Indian number, and `+91…` always as India.
 */
export function splitPhone(
  value: string | undefined | null,
  countries: PhoneCountries = DEFAULT_PHONE_COUNTRIES,
): PhoneParts {
  const raw = (value ?? '').replace(/[\s\-()]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    // `919876543210` is the +91 number without its plus.
    if (digits.length === 2 + INDIA_NATIONAL_DIGITS && digits.startsWith('91')) {
      return { code: IN_DIAL_CODE, national: digits.slice(2) };
    }
    // `09876543210` carries the trunk 0.
    if (digits.length === 1 + INDIA_NATIONAL_DIGITS && digits.startsWith('0')) {
      return { code: IN_DIAL_CODE, national: digits.slice(1) };
    }
    return { code: IN_DIAL_CODE, national: digits };
  }
  const listed = countries.find((c) => digits.startsWith(c.code.slice(1)));
  if (listed) return { code: listed.code, national: digits.slice(listed.code.length - 1) };
  // An unlisted code is 1-3 digits; keep the last 10 as the number.
  const codeLength = Math.min(3, Math.max(1, digits.length - INDIA_NATIONAL_DIGITS));
  return { code: `+${digits.slice(0, codeLength)}`, national: digits.slice(codeLength) };
}

/**
 * Reads what was typed or pasted into the number box. A full number (`+91 98765
 * 43210`, `919876543210`) or one with a trunk `0` is reduced to its national
 * part instead of being cut short into a different number. A number with an
 * unlisted code keeps all its digits, so it fails validation rather than
 * turning into a different valid number.
 */
export function nationalFromInput(
  raw: string,
  code: string,
  countries: PhoneCountries = DEFAULT_PHONE_COUNTRIES,
): PhoneParts {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) {
    const parts = splitPhone(trimmed, countries);
    if (phoneCountry(parts.code, countries)) {
      const max = nationalMaxLength(parts.code, countries);
      return { code: parts.code, national: parts.national.slice(0, max) };
    }
    return { code, national: trimmed.replace(/\D/g, '') };
  }
  let digits = trimmed.replace(/\D/g, '');
  const codeDigits = code.replace(/\D/g, '');
  const max = nationalMaxLength(code, countries);
  if (digits.length > max && codeDigits && digits.startsWith(codeDigits)) {
    digits = digits.slice(codeDigits.length);
  }
  if (digits.length === max + 1 && digits.startsWith('0')) digits = digits.slice(1);
  return { code, national: digits.slice(0, max) };
}

/** Joins code and number for storage; `undefined` when no number was typed. */
export function joinPhone(code: string, national: string): string | undefined {
  const digits = national.replace(/\D/g, '');
  return digits ? `${code}${digits}` : undefined;
}

/**
 * True for an Indian mobile (`+91` and 10 digits starting 6-9, or the bare 10
 * digits) or another `+code` number the server's `normalisePhone` accepts.
 */
export function isValidPhone(value: string): boolean {
  return normalisePhone(value).ok;
}

/** True for any number the server accepts (landlines too); for optional contact fields. */
export function isAcceptedPhone(value: string): boolean {
  return normaliseContactPhone(value).ok;
}
