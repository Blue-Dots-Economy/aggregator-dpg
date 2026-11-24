/**
 * Per-country phone parsing for `@aggregator-dpg/shared-primitives`, backed by
 * libphonenumber-js. Callers pass the deployment's countries; the first one is
 * the country a number without a `+` is read in.
 *
 * @module @aggregator-dpg/shared-primitives
 */

import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
  Metadata,
  parsePhoneNumberFromString,
  type CountryCode,
  type NumberType,
} from 'libphonenumber-js/max';
import mobileExamples from 'libphonenumber-js/mobile/examples';

export type { CountryCode };

/** Which numbers a field takes: `mobile` for a login or OTP phone, `any` for a contact phone (landlines too). */
export type PhoneKind = 'mobile' | 'any';

/** Why a phone was refused. */
export type PhoneParseReason =
  'empty' | 'not_a_number' | 'country_not_allowed' | 'invalid' | 'not_mobile';

/** The countries a field accepts and the kind of number it needs. */
export interface PhoneRules {
  /** Accepted countries; the first is the default for a number typed without `+`. */
  countries: readonly [CountryCode, ...CountryCode[]];
  kind: PhoneKind;
}

/** A parsed phone in E.164 form, e.g. `+919876543210`. */
export interface PhoneParseOk {
  ok: true;
  value: string;
}

/** A refused phone with its reason and a message that can be shown to the user. */
export interface PhoneParseError {
  ok: false;
  error: { reason: PhoneParseReason; message: string };
}

/** Outcome of {@link parsePhone}. */
export type PhoneParseResult = PhoneParseOk | PhoneParseError;

/**
 * A phone as stored: `+` then 10-15 digits. Matches the SQL `contact_phone_chk`,
 * so a few valid numbers of small countries (9 digits in all) are refused up front.
 */
export const STORED_PHONE_REGEX = /^\+\d{10,15}$/;

/** Number types a mobile field accepts; some countries (US, CA) do not tell mobiles from landlines. */
const MOBILE_TYPES: ReadonlySet<NumberType> = new Set<NumberType>([
  'MOBILE',
  'FIXED_LINE_OR_MOBILE',
]);

function refuse(reason: PhoneParseReason, message: string): PhoneParseError {
  return { ok: false, error: { reason, message } };
}

/**
 * Parses a phone typed in any spacing or punctuation and checks it against
 * its own country's rules. A country is allowed by its calling code, so GB
 * also admits other +44 numbers (Guernsey, Jersey) and US admits Canada. Does
 * not throw.
 *
 * @param raw - The phone as typed.
 * @param rules - The accepted countries and the kind of number needed.
 * @returns The E.164 phone, or the reason it was refused.
 */
export function parsePhone(raw: string, rules: PhoneRules): PhoneParseResult {
  if (!raw?.trim()) return refuse('empty', 'phone is empty');
  const phone = parsePhoneNumberFromString(raw, rules.countries[0]);
  if (!phone) return refuse('not_a_number', 'phone is not a phone number');

  const code = `+${phone.countryCallingCode}`;
  const allowed = rules.countries.some(
    (c) => getCountryCallingCode(c) === phone.countryCallingCode,
  );
  if (!allowed)
    return refuse('country_not_allowed', `phone numbers starting ${code} are not accepted`);
  if (!phone.isValid() || !STORED_PHONE_REGEX.test(phone.number)) {
    return refuse('invalid', `phone is not a valid ${code} number`);
  }

  const type = phone.getType();
  if (rules.kind === 'mobile' && !(type && MOBILE_TYPES.has(type))) {
    return refuse('not_mobile', 'phone must be a mobile number');
  }
  return { ok: true, value: phone.number };
}

/** A deployment's accepted countries; the first is the default. */
export type PhoneCountryList = readonly [CountryCode, ...CountryCode[]];

/** Countries used when `PHONE_COUNTRIES` is blank. */
export const DEFAULT_PHONE_COUNTRIES: PhoneCountryList = ['IN'];

/** Outcome of {@link readPhoneCountries}. */
export type PhoneCountriesResult =
  { ok: true; value: PhoneCountryList } | { ok: false; error: { message: string } };

/** One `PHONE_COUNTRIES` entry: two-letter country, `:`, then the dial code with an optional `+`. */
const COUNTRY_ENTRY = /^([A-Za-z]{2})\s*:\s*\+?(\d+)$/;

/**
 * Reads a deployment's country list, e.g. `IN:+91,GB:+44`. The first entry is
 * the default. Every entry must be a known country with its real dial code, so
 * a typo fails instead of silently changing the default. Blank means
 * {@link DEFAULT_PHONE_COUNTRIES}.
 *
 * @param raw - The `PHONE_COUNTRIES` value.
 * @returns The countries, or a message naming the first bad entry.
 */
export function readPhoneCountries(raw: string | undefined): PhoneCountriesResult {
  if (!raw?.trim()) return { ok: true, value: DEFAULT_PHONE_COUNTRIES };
  const list: CountryCode[] = [];
  for (const entry of raw.split(',').map((e) => e.trim())) {
    const bad = (why: string): PhoneCountriesResult => ({
      ok: false,
      error: { message: `PHONE_COUNTRIES entry "${entry}" ${why}` },
    });
    const match = COUNTRY_ENTRY.exec(entry);
    const iso = match?.[1]?.toUpperCase();
    const dial = match?.[2];
    if (!iso || !dial) return bad('is not in the form XX:+NN');
    if (!isSupportedCountry(iso)) return bad(`has an unknown country ${iso}`);
    const real = getCountryCallingCode(iso);
    if (dial !== real) return bad(`has the wrong dial code; ${iso} is +${real}`);
    if (list.includes(iso)) return bad('is listed twice');
    if (list.some((c) => getCountryCallingCode(c) === real)) {
      return bad(`repeats the dial code +${real}; list one country per code`);
    }
    if (real.length + phoneCountryInfo(iso).sample.length < MIN_STORED_DIGITS) {
      return bad(`is not supported; ${iso} mobile numbers are shorter than a stored phone allows`);
    }
    list.push(iso);
  }
  const [first, ...rest] = list;
  return first
    ? { ok: true, value: [first, ...rest] }
    : { ok: true, value: DEFAULT_PHONE_COUNTRIES };
}

/** What a phone box needs to know about one country. */
export interface PhoneCountryInfo {
  /** Two-letter country code, e.g. `IN`. */
  iso: CountryCode;
  /** Dial code with its plus, e.g. `+91`. */
  code: string;
  /** Most digits a mobile or landline number has after the dial code. */
  nationalDigits: number;
  /** A valid mobile number without the dial code, e.g. `8123456789`. */
  sample: string;
}

/** Longest national number E.164 allows, used when the library has no lengths. */
const MAX_NATIONAL_DIGITS = 14;

/** Fewest and most digits in a stored phone, code included ({@link STORED_PHONE_REGEX}). */
const MIN_STORED_DIGITS = 10;
const MAX_E164_DIGITS = 15;

const METADATA = new Metadata();

/** Possible national lengths of one number type; the library's typings omit `type()`, so it is checked at runtime. */
function typeLengths(plan: unknown, type: 'MOBILE' | 'FIXED_LINE'): number[] {
  const typeOf: unknown =
    typeof plan === 'object' && plan !== null ? Reflect.get(plan, 'type') : null;
  if (typeof typeOf !== 'function') return [];
  const desc: unknown = Reflect.apply(typeOf, plan, [type]);
  const lengthsOf: unknown =
    typeof desc === 'object' && desc !== null ? Reflect.get(desc, 'possibleLengths') : null;
  if (typeof lengthsOf !== 'function') return [];
  const lengths: unknown = Reflect.apply(lengthsOf, desc, []);
  return Array.isArray(lengths) ? lengths.filter((n): n is number => typeof n === 'number') : [];
}

/** Longest national number a mobile or landline in `iso` can have; 0 when unknown. */
function longestNationalNumber(iso: CountryCode): number {
  METADATA.selectNumberingPlan(iso);
  const plan = METADATA.numberingPlan;
  return Math.max(0, ...typeLengths(plan, 'MOBILE'), ...typeLengths(plan, 'FIXED_LINE'));
}

/** Every country the library knows, India first; for numbers the deployment configures itself, such as voice bots. */
export const ALL_PHONE_COUNTRIES: PhoneCountryList = [
  'IN',
  ...getCountries().filter((c) => c !== 'IN'),
];

/**
 * A cleaned phone in the form its schema field's `pattern` accepts: E.164, or the
 * number without its code when the pattern takes bare digits and the phone is from `home`.
 *
 * @param e164 - A number as {@link parsePhone} returns it.
 * @param schema - The row or form JSON schema, or null when it did not load.
 * @param field - The phone property.
 * @param home - The deployment's default country.
 * @returns The value to validate and store; E.164 when no other form fits.
 */
export function phoneForSchema(
  e164: string,
  schema: Record<string, unknown> | null,
  field: string,
  home: CountryCode,
): string {
  const props = schema?.['properties'];
  const prop: unknown = props && typeof props === 'object' ? Reflect.get(props, field) : null;
  const pattern: unknown = prop && typeof prop === 'object' ? Reflect.get(prop, 'pattern') : null;
  if (typeof pattern !== 'string') return e164;
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'u');
  } catch {
    return e164; // a bad pattern is reported by the schema check itself
  }
  if (re.test(e164)) return e164;
  const phone = parsePhoneNumberFromString(e164);
  if (phone?.countryCallingCode !== getCountryCallingCode(home)) return e164;
  return re.test(phone.nationalNumber) ? phone.nationalNumber : e164;
}

/**
 * Describes a country for a phone box: its dial code, how many digits its
 * mobiles have, and a sample mobile number.
 *
 * @param iso - The country.
 * @returns The country's phone details.
 */
export function phoneCountryInfo(iso: CountryCode): PhoneCountryInfo {
  const example = getExampleNumber(iso, mobileExamples);
  const dial = getCountryCallingCode(iso);
  const sample = example ? String(example.nationalNumber) : '';
  return {
    iso,
    code: `+${dial}`,
    nationalDigits: Math.min(
      Math.max(sample.length, longestNationalNumber(iso)) || MAX_NATIONAL_DIGITS,
      MAX_E164_DIGITS - dial.length,
    ),
    sample,
  };
}
