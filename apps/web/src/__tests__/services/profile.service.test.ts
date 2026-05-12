import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { profileService } from '../../services/profile.service';

const apiResponse = {
  aggregator_id: 'agg-1',
  org_slug: 'trrain-abcd',
  org_name: 'TRRAIN',
  actor_type: 'aggregator',
  type: null,
  url: null,
  contact: {
    name: 'Asha Rao',
    phone: '+919876543210',
    email: 'asha@trrain.org',
  },
  locations: [
    {
      geo: { type: 'Point', coordinates: [72.8777, 19.076] },
      address: {
        streetAddress: '2nd Floor, Trade Centre',
        addressLocality: 'Mumbai',
        addressRegion: 'Maharashtra',
        postalCode: '400051',
        addressCountry: 'IN',
      },
    },
  ],
  consent: { value: true, given_at: '2026-01-01T00:00:00Z', valid_till: '2027-01-01T00:00:00Z' },
  status: 'active',
  contact_name: 'Asha Rao',
  personas: [{ id: 'persona-iti-seeker', name: 'Women in retail' }],
  services: [{ id: 'service-bluedots-job', name: 'BlueDots Job' }],
  verified_certificate: [],
  profile_completed_at: '2026-04-30T00:00:00Z',
  identity: {
    first_name: 'Asha',
    last_name: 'Rao',
    email: 'asha@trrain.org',
    email_verified: true,
    phone: '+919876543210',
    phone_verified: false,
    active: true,
  },
  is_complete: true,
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

  it('renders empty aggregator-details when personas/services/locations are empty', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...apiResponse,
            personas: [],
            services: [],
            locations: [],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
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
