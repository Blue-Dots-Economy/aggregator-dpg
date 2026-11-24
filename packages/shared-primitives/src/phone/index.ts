/**
 * Contact-detail normalisation shared by every aggregator process.
 *
 * Phones are checked per country by `parsePhone` (see `./parse.ts`); this file
 * adds the email helpers and the India constants the web phone box uses.
 *
 * @module @aggregator-dpg/shared-primitives
 */

export * from './parse.js';

/** Digits in a local mobile number (India), without the country code. */
export const PHONE_LOCAL_DIGITS = 10;
/** Country calling code assumed for a bare local number, without the `+`. */
export const PHONE_COUNTRY_CODE = '91';

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
