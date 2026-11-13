/**
 * Contact-detail normalisation shared by every aggregator process.
 *
 * Phone numbers keep digits and one leading `+`. A bare 10-digit number is
 * treated as Indian (`+91`). An identity phone (`normalisePhone`) must be an
 * Indian mobile when it is `+91`; a contact phone (`normaliseContactPhone`) may
 * be a landline.
 *
 * @module @aggregator-dpg/shared-primitives
 */

/** Successful normalisation carrying the canonical value. */
export interface PhoneNormaliseOk {
  ok: true;
  value: string;
}

/** Failed normalisation carrying a human-readable reason. */
export interface PhoneNormaliseError {
  ok: false;
  error: { message: string };
}

/** Outcome of {@link normalisePhone}. */
export type PhoneNormaliseResult = PhoneNormaliseOk | PhoneNormaliseError;

/** Digits in a local mobile number (India), without the country code. */
export const PHONE_LOCAL_DIGITS = 10;
/** Country calling code assumed for a bare local number, without the `+`. */
export const PHONE_COUNTRY_CODE = '91';

const MIN_DIGITS = PHONE_LOCAL_DIGITS;
const MAX_DIGITS = 15;
const DEFAULT_COUNTRY_CODE = PHONE_COUNTRY_CODE;

/** An Indian mobile after `+91`: 10 digits starting 6-9. */
const INDIA_MOBILE = /^[6-9]\d{9}$/;
/** Any Indian number after `+91`, landlines included: 10 digits, the first 1-9. */
const INDIA_ANY = /^[1-9]\d{9}$/;

/**
 * Reads typed input as `+` and digits. A bare 10-digit number is Indian, a
 * trunk `0` before it is dropped, a leading `00` means `+`, and `91` and 10
 * digits is the `+91` number.
 */
function toInternational(raw: string): string {
  const cleaned = raw.trim().replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  // `00` is the international dialling prefix, the same as `+`.
  if (cleaned.startsWith('00')) return `+${cleaned.slice(2)}`;
  if (cleaned.length === MIN_DIGITS) return `+${DEFAULT_COUNTRY_CODE}${cleaned}`;
  if (cleaned.length === MIN_DIGITS + 1 && cleaned.startsWith('0')) {
    return `+${DEFAULT_COUNTRY_CODE}${cleaned.slice(1)}`;
  }
  return `+${cleaned}`;
}

/** Checks the international form; `+91` (always India, as dial codes never share a prefix) must match `india`. */
function checkPhone(raw: string, india: RegExp, indiaMessage: string): PhoneNormaliseResult {
  if (!raw?.trim()) return { ok: false, error: { message: 'phone is empty' } };
  const value = toInternational(raw);
  const digits = value.slice(1);
  if (!/^[1-9]\d*$/.test(digits) || digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    const typed = raw.trim().replace(/[^\d+]/g, '');
    const prefix = ['+', '00'].find((p) => typed.startsWith(p));
    let message = `phone has ${typed.length} digits; expected ${MIN_DIGITS}-${MAX_DIGITS}`;
    if (prefix && digits.startsWith('0')) message = `phone cannot start with 0 after the ${prefix}`;
    else if (prefix === '+') {
      message = `phone must have ${MIN_DIGITS}-${MAX_DIGITS} digits after country code`;
    }
    return { ok: false, error: { message } };
  }
  if (
    digits.startsWith(PHONE_COUNTRY_CODE) &&
    !india.test(digits.slice(PHONE_COUNTRY_CODE.length))
  ) {
    return { ok: false, error: { message: indiaMessage } };
  }
  return { ok: true, value };
}

/**
 * Normalises an identity phone (login, OTP, participant) to `+<digits>`. A
 * `+91` number must be a mobile: 10 digits starting 6-9. Does not throw.
 *
 * @param raw - User-supplied phone string, in any spacing or punctuation.
 * @returns `{ ok: true, value }`, or `{ ok: false, error }` with the reason.
 */
export function normalisePhone(raw: string): PhoneNormaliseResult {
  return checkPhone(
    raw,
    INDIA_MOBILE,
    `a +${PHONE_COUNTRY_CODE} phone must be a 10-digit mobile number starting 6-9`,
  );
}

/**
 * Normalises a contact phone (support, a person to call back), where an Indian
 * landline is fine: a `+91` number needs 10 digits, the first 1-9. Does not throw.
 *
 * @param raw - User-supplied phone string, in any spacing or punctuation.
 * @returns `{ ok: true, value }`, or `{ ok: false, error }` with the reason.
 */
export function normaliseContactPhone(raw: string): PhoneNormaliseResult {
  return checkPhone(
    raw,
    INDIA_ANY,
    `a +${PHONE_COUNTRY_CODE} phone must have ${PHONE_LOCAL_DIGITS} digits after the country code, not starting with 0`,
  );
}

/**
 * Trims and lower-cases an email address. Blank input becomes `null`.
 *
 * @param raw - User-supplied email, or `null`/`undefined` when not provided.
 * @returns The normalised address, or `null` when there was nothing usable.
 */
export function normaliseEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}

// Simple email check to reject obvious garbage. Linear: no catastrophic backtracking.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Whether `email` looks like an email address: one `@`, no spaces, and a
 * dotted domain. A shape check only; it does not prove the mailbox exists.
 *
 * @param email - The address, already trimmed.
 * @returns `true` when the shape is acceptable.
 */
export function isEmailAddress(email: string): boolean {
  return EMAIL_RE.test(email);
}
