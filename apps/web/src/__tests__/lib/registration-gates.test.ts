/**
 * Unit tests for the #613 registration-form gate predicates.
 *
 * @module @aggregator-dpg/web
 */

import { describe, it, expect } from 'vitest';
import {
  domainRequiresConsent,
  domainRequiresBirthYear,
  CONSENT_REQUIRED_GATE,
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
