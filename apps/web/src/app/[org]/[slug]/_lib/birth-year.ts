/**
 * Year-of-birth rules for the public registration forms (web app).
 *
 * Age is derived from the birth year; no birthdate is stored.
 */

/** Oldest age, in years, a birth year may give before it is rejected as a typo. */
export const MAX_AGE_YEARS = 120;

/**
 * Highest age, in years, that counts as a minor. A minor submits without
 * consent and accepts terms later in the Signalstack app.
 */
export const MINOR_MAX_AGE_YEARS = 18;

/** Number of years the birth-year select offers, counting back from this year. */
export const BIRTH_YEAR_OPTION_COUNT = 101;

/** What a year-of-birth value means for the submit. */
export interface BirthYearReading {
  /** A four-digit year within {@link MAX_AGE_YEARS} of `currentYear`, not in the future. */
  valid: boolean;
  /** Valid, and the derived age is at most {@link MINOR_MAX_AGE_YEARS}. */
  isMinor: boolean;
}

/**
 * Reads a year-of-birth value as entered or selected.
 *
 * @param raw - The value; surrounding spaces are ignored.
 * @param currentYear - This calendar year.
 */
export function readBirthYear(raw: string, currentYear: number): BirthYearReading {
  const trimmed = raw.trim();
  const year = Number(trimmed);
  const valid =
    /^\d{4}$/.test(trimmed) && year >= currentYear - MAX_AGE_YEARS && year <= currentYear;
  return { valid, isMinor: valid && currentYear - year <= MINOR_MAX_AGE_YEARS };
}

/**
 * Years the birth-year select offers, newest first.
 *
 * @param currentYear - This calendar year.
 */
export function birthYearOptions(currentYear: number): number[] {
  return Array.from({ length: BIRTH_YEAR_OPTION_COUNT }, (_, i) => currentYear - i);
}
