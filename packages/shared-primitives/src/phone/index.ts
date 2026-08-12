/**
 * Contact-detail normalisation shared by every aggregator process.
 *
 * Coarse-grained for MVP: phone numbers keep digits and a single leading `+`,
 * and a bare 10-digit input is assumed to be Indian (`+91`). Swap in
 * libphonenumber-js if richer validation is ever required.
 *
 * Previously duplicated between `apps/api/src/services/phone.ts` and
 * `apps/worker/src/services/phone.ts`; promoted here now that both the API and
 * the worker consume it.
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

const MIN_DIGITS = 10;
const MAX_DIGITS = 15;
const DEFAULT_COUNTRY_CODE = '91';

/**
 * Normalises a phone number to a canonical E.164-ish form that other code can
 * index on. Returns an error result for clearly invalid input rather than
 * throwing, so callers can map it onto their own error shape.
 *
 * @param raw - User-supplied phone string, in any spacing/punctuation.
 * @returns `{ ok: true, value }` with a `+`-prefixed digit string, or
 *   `{ ok: false, error }` describing why the input was rejected.
 */
export function normalisePhone(raw: string): PhoneNormaliseResult {
  if (!raw) return { ok: false, error: { message: 'phone is empty' } };
  // Keep an optional leading + and digits only.
  const cleaned = raw.trim().replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
      return {
        ok: false,
        error: {
          message: `phone must have ${MIN_DIGITS}-${MAX_DIGITS} digits after country code`,
        },
      };
    }
    return { ok: true, value: `+${digits}` };
  }

  // Bare digits — assume the default region when exactly 10 digits.
  if (cleaned.length === MIN_DIGITS) {
    return { ok: true, value: `+${DEFAULT_COUNTRY_CODE}${cleaned}` };
  }
  if (cleaned.length > MIN_DIGITS && cleaned.length <= MAX_DIGITS) {
    return { ok: true, value: `+${cleaned}` };
  }
  return {
    ok: false,
    error: {
      message: `phone has ${cleaned.length} digits; expected ${MIN_DIGITS}-${MAX_DIGITS}`,
    },
  };
}

/**
 * Normalises an email address for storage and comparison: trimmed and
 * lower-cased, with blank input collapsed to `null` so "absent" and
 * "whitespace only" are indistinguishable downstream.
 *
 * @param raw - User-supplied email, or `null`/`undefined` when not provided.
 * @returns The normalised address, or `null` when there was nothing usable.
 */
export function normaliseEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}
