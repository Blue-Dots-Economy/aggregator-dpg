/**
 * Unit tests for the #613 registration-form gate predicates.
 *
 * @module @aggregator-dpg/web
 */

import { describe, it, expect } from 'vitest';
import {
  domainRequiresConsent,
  domainRequiresBirthYear,
  registrationShowsConsent,
  CONSENT_REQUIRED_GATE,
  isMinorBirthYear,
  isValidBirthYear,
} from '@/lib/registration-gates';
import type { AggregatorConfigDomain } from '@/hooks/useAggregatorConfig';

const base: AggregatorConfigDomain = {
  id: 'seeker',
  label: 'Seeker',
  plural_label: 'Seekers',
  item_type: 'profile_1.0',
};

describe('domainRequiresConsent', () => {
  it('is true only when go_live_required includes the consent gate', () => {
    expect(
      domainRequiresConsent({
        ...base,
        go_live_required: ['schema_required', CONSENT_REQUIRED_GATE],
      }),
    ).toBe(true);
  });

  it('is false when the consent gate is absent from go_live_required', () => {
    expect(domainRequiresConsent({ ...base, go_live_required: ['schema_required'] })).toBe(false);
  });

  it('defaults to false when go_live_required is absent (empty / undefined)', () => {
    expect(domainRequiresConsent({ ...base })).toBe(false);
    expect(domainRequiresConsent({ ...base, go_live_required: [] })).toBe(false);
  });

  it('defaults to false for an undefined domain (config not yet loaded)', () => {
    expect(domainRequiresConsent(undefined)).toBe(false);
  });
});

describe('domainRequiresBirthYear', () => {
  it('is true only when guardian_consent_required is true', () => {
    expect(domainRequiresBirthYear({ ...base, guardian_consent_required: true })).toBe(true);
  });

  it('defaults to false when guardian_consent_required is false / absent', () => {
    expect(domainRequiresBirthYear({ ...base, guardian_consent_required: false })).toBe(false);
    expect(domainRequiresBirthYear({ ...base })).toBe(false);
  });

  it('defaults to false for an undefined domain', () => {
    expect(domainRequiresBirthYear(undefined)).toBe(false);
  });
});

describe('registrationShowsConsent', () => {
  it('is true when go_live_required includes the consent gate', () => {
    expect(registrationShowsConsent({ ...base, go_live_required: [CONSENT_REQUIRED_GATE] })).toBe(
      true,
    );
  });

  it('is true for a guardian domain even if go_live_required omits the consent gate', () => {
    // signalstack force-adds consent_required for guardian domains; mirror it so
    // a birth-year domain never skips the consent step (config drift / older payload).
    expect(
      registrationShowsConsent({
        ...base,
        guardian_consent_required: true,
        go_live_required: ['schema_required'],
      }),
    ).toBe(true);
  });

  it('is false when neither consent gate nor guardian consent applies', () => {
    expect(registrationShowsConsent({ ...base, go_live_required: ['schema_required'] })).toBe(
      false,
    );
    expect(registrationShowsConsent({ ...base })).toBe(false);
    expect(registrationShowsConsent(undefined)).toBe(false);
  });
});

describe('birth year', () => {
  it('accepts a four-digit year up to 120 years back and not in the future', () => {
    expect(isValidBirthYear('1906', 2026)).toBe(true);
    expect(isValidBirthYear(' 2026 ', 2026)).toBe(true);
    expect(isValidBirthYear('1905', 2026)).toBe(false);
    expect(isValidBirthYear('2027', 2026)).toBe(false);
    expect(isValidBirthYear('86', 2026)).toBe(false);
    expect(isValidBirthYear(undefined, 2026)).toBe(false);
  });

  it('treats age 18 and under as a minor, and an invalid year as not a minor', () => {
    expect(isMinorBirthYear('2008', 2026)).toBe(true);
    expect(isMinorBirthYear('2007', 2026)).toBe(false);
    expect(isMinorBirthYear('2027', 2026)).toBe(false);
    expect(isMinorBirthYear('', 2026)).toBe(false);
  });
});
