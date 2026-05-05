import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { profileService } from '../../services/profile.service';

const apiResponse = {
  aggregator_id: 'agg-1',
  org_slug: 'trrain-abcd',
  org_name: 'TRRAIN',
  type: 'seeker',
  identity: {
    first_name: 'Asha',
    last_name: 'Rao',
    email: 'asha@trrain.org',
    email_verified: true,
    phone: '+919876543210',
    phone_verified: false,
    active: true,
  },
  schema_version: 1,
  data: {
    who_i_am: { address: 'Mumbai 400051' },
    what_i_want: { beneficiary_groups: ['Women in retail'], geographies: ['Maharashtra'] },
  },
  consent: { profile_creation: true },
  is_complete: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-04-30T00:00:00Z',
};

describe('profileService', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(apiResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps API identity to AggregatorProfile.contact', async () => {
    const profile = await profileService.get();
    expect(profile.org).toBe('TRRAIN');
    expect(profile.contact.name).toBe('Asha Rao');
    expect(profile.contact.email).toBe('asha@trrain.org');
    expect(profile.contact.mobile).toBe('+919876543210');
    expect(profile.consent.profileCreation).toBe(true);
  });

  it('renders empty aggregator-details when JSONB data is empty', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...apiResponse, data: {}, consent: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const profile = await profileService.get();
    expect(profile.beneficiaries).toBe('');
    expect(profile.geographies).toBe('');
    expect(profile.address).toBe('');
  });

  it('throws when API returns non-2xx', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(profileService.get()).rejects.toThrow(/503/);
  });
});
