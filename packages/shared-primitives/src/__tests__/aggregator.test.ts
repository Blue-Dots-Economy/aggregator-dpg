import { describe, expect, it } from 'vitest';
import {
  AggregatorViewSchema,
  ConsentRecordSchema,
  ProfilePayloadSchema,
  RegistrationConsentSchema,
  RegistrationPayloadSchema,
} from '../aggregator/index.js';

const validContact = {
  name: 'Rajesh',
  phone: '+919876543210',
  email: 'admin@skillbridge.in',
};

const validConsent = {
  value: true,
  given_at: '2026-01-15T10:00:00Z',
  valid_till: '2027-01-15T10:00:00Z',
};

describe('ConsentRecordSchema', () => {
  it('accepts boolean value (storage shape — does not require literal true)', () => {
    expect(() => ConsentRecordSchema.parse({ ...validConsent, value: false })).not.toThrow();
  });

  it('rejects non-ISO given_at', () => {
    expect(() => ConsentRecordSchema.parse({ ...validConsent, given_at: 'yesterday' })).toThrow();
  });
});

describe('RegistrationConsentSchema', () => {
  it('rejects consent.value=false at registration time', () => {
    expect(() => RegistrationConsentSchema.parse({ ...validConsent, value: false })).toThrow();
  });
});

describe('RegistrationPayloadSchema', () => {
  it('accepts the minimum valid signup body', () => {
    const parsed = RegistrationPayloadSchema.parse({
      name: 'SkillBridge Network',
      type: 'seeker',
      contact: validContact,
      consent: validConsent,
    });
    expect(parsed.locations).toEqual([]);
    expect(parsed.contact.email).toBe('admin@skillbridge.in');
  });

  it('rejects payloads missing required fields', () => {
    expect(() => RegistrationPayloadSchema.parse({ name: 'x', consent: validConsent })).toThrow();
  });

  it('rejects "both" — only seeker | provider allowed at signup', () => {
    expect(() =>
      RegistrationPayloadSchema.parse({
        name: 'SkillBridge Network',
        type: 'both',
        contact: validContact,
        consent: validConsent,
      }),
    ).toThrow();
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() =>
      RegistrationPayloadSchema.parse({
        name: 'x',
        type: 'seeker',
        contact: validContact,
        consent: validConsent,
        personas: [],
      }),
    ).toThrow();
  });
});

describe('ProfilePayloadSchema', () => {
  it('accepts a partial profile (all fields optional)', () => {
    expect(() => ProfilePayloadSchema.parse({})).not.toThrow();
    expect(() =>
      ProfilePayloadSchema.parse({
        contact_name: 'Primary Contact',
        personas: [{ id: 'persona-iti-seeker', name: 'ITI Seeker' }],
      }),
    ).not.toThrow();
  });

  it('rejects malformed persona refs', () => {
    expect(() =>
      ProfilePayloadSchema.parse({
        personas: [{ id: '' } as unknown as { id: string; name: string }],
      }),
    ).toThrow();
  });
});

describe('AggregatorViewSchema', () => {
  const baseView = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    org_slug: 'skillbridge-a3f9',
    actor_type: 'aggregator' as const,
    name: 'SkillBridge',
    type: null,
    url: null,
    contact: validContact,
    locations: [],
    contact_name: null,
    personas: [],
    services: [],
    verified_certificate: [],
    profile_completed_at: null,
    consent: validConsent,
    status: 'pending' as const,
    created_by: 'system',
    updated_by: 'system',
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T10:00:00Z',
  };

  it('accepts actor_type=aggregator with type=null', () => {
    expect(() => AggregatorViewSchema.parse(baseView)).not.toThrow();
  });

  it('rejects actor_type=aggregator with type=seeker', () => {
    expect(() => AggregatorViewSchema.parse({ ...baseView, type: 'seeker' })).toThrow();
  });

  it('rejects actor_type=seeker with type=null', () => {
    expect(() =>
      AggregatorViewSchema.parse({ ...baseView, actor_type: 'seeker', type: null }),
    ).toThrow();
  });

  it('rejects actor_type=seeker with type=both (legacy value no longer accepted)', () => {
    expect(() =>
      AggregatorViewSchema.parse({ ...baseView, actor_type: 'seeker', type: 'both' }),
    ).toThrow();
  });

  it('accepts actor_type=seeker with type=seeker', () => {
    expect(() =>
      AggregatorViewSchema.parse({ ...baseView, actor_type: 'seeker', type: 'seeker' }),
    ).not.toThrow();
  });

  it('accepts actor_type=provider with type=provider', () => {
    expect(() =>
      AggregatorViewSchema.parse({ ...baseView, actor_type: 'provider', type: 'provider' }),
    ).not.toThrow();
  });
});
