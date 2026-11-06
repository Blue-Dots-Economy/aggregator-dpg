import { describe, it, expect } from 'vitest';
import { birthYearOptions, readBirthYear } from '@/app/[org]/[slug]/_lib/birth-year';

const YEAR = 2026;

describe('readBirthYear', () => {
  it('reads an adult year as valid and not a minor', () => {
    expect(readBirthYear('1990', YEAR)).toEqual({ valid: true, isMinor: false });
  });

  it('counts age 18 as a minor and age 19 as an adult', () => {
    expect(readBirthYear('2008', YEAR)).toEqual({ valid: true, isMinor: true });
    expect(readBirthYear('2007', YEAR)).toEqual({ valid: true, isMinor: false });
  });

  it('accepts this year and the year 120 years back, with spaces around', () => {
    expect(readBirthYear(' 2026 ', YEAR).valid).toBe(true);
    expect(readBirthYear('1906', YEAR).valid).toBe(true);
  });

  it('rejects empty, future, too old and non-four-digit values', () => {
    for (const raw of ['', '2027', '1905', '99', '19900', 'abcd', '2e03']) {
      expect(readBirthYear(raw, YEAR)).toEqual({ valid: false, isMinor: false });
    }
  });
});

describe('birthYearOptions', () => {
  it('lists 101 years from this year back', () => {
    const years = birthYearOptions(YEAR);
    expect(years).toHaveLength(101);
    expect(years[0]).toBe(2026);
    expect(years.at(-1)).toBe(1926);
  });
});
