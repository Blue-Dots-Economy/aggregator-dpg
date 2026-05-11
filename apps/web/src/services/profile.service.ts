import type { AggregatorProfile } from '../types';

export interface ProfileService {
  get(): Promise<AggregatorProfile>;
  update(patch: Partial<AggregatorProfile>): Promise<AggregatorProfile>;
}

interface BecknContact {
  name: string;
  phone: string;
  email: string;
  alternatePhone?: string;
  company?: string;
  gstNumber?: string;
}

interface BecknLocation {
  geo: { type: string; coordinates?: unknown };
  address?: Record<string, string | undefined>;
}

interface PersonaRef {
  id: string;
  name: string;
}

interface ServiceRef {
  id: string;
  name: string;
}

/**
 * Merged GET /v1/aggregators/profile/me response shape after the two-table
 * refactor. `aggregator.*` fields are flattened into the top level alongside
 * the post-login `aggregator_profile` fields.
 */
interface ProfileApiResponse {
  aggregator_id: string;
  org_slug: string;
  org_name: string;
  actor_type: 'aggregator' | 'seeker' | 'provider';
  type: 'seeker' | 'provider' | 'both' | null;
  url: string | null;
  contact: BecknContact;
  locations: BecknLocation[];
  consent: { value: boolean; given_at: string; valid_till: string };
  status: 'pending' | 'active' | 'inactive' | 'retired';
  // Post-login profile
  contact_name: string | null;
  personas: PersonaRef[];
  services: ServiceRef[];
  verified_certificate: unknown[];
  profile_completed_at: string | null;
  identity: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    email_verified: boolean;
    phone: string | null;
    phone_verified: boolean;
    active: boolean;
  };
  is_complete: boolean;
  created_at: string;
  updated_at: string;
}

class ApiProfileService implements ProfileService {
  async get(): Promise<AggregatorProfile> {
    const res = await fetch('/api/aggregator/profile/me', { credentials: 'include' });
    if (!res.ok) {
      throw new Error(`profile fetch failed: ${res.status}`);
    }
    const body = (await res.json()) as ProfileApiResponse;
    return mapToAggregatorProfile(body);
  }

  async update(patch: Partial<AggregatorProfile>): Promise<AggregatorProfile> {
    // Profile completion form PUTs `data` + `consent` JSONB shapes directly
    // to /api/aggregator/profile/me. Patch-based updates are not yet wired —
    // return a fresh fetch so callers stay consistent.
    void patch;
    return this.get();
  }
}

function mapToAggregatorProfile(api: ProfileApiResponse): AggregatorProfile {
  // Display the Beckn contact.name as the coordinator. Fall back to KC
  // identity (firstName + lastName) when the contact has not been set, then
  // to the profile's separate contact_name label.
  const identityFull = [api.identity.first_name, api.identity.last_name]
    .filter((p): p is string => Boolean(p && p.length > 0))
    .join(' ');
  const coordinator = api.contact?.name || api.contact_name || identityFull;

  // Render the first location's postal address as a single line for the
  // dashboard card. Profile-completion page can render the full array.
  const firstLoc = api.locations?.[0]?.address;
  const address = firstLoc
    ? [
        firstLoc.streetAddress,
        firstLoc.addressLocality,
        firstLoc.addressRegion,
        firstLoc.postalCode,
      ]
        .filter((p): p is string => Boolean(p && p.length > 0))
        .join(', ')
    : '';

  // Personas + services live on the profile half of the response. Render
  // them as bullet-separated lists for the existing dashboard layout.
  const beneficiaries = api.personas.map((p) => p.name).join(' · ');
  const geographies = api.locations
    .map((loc) => loc.address?.addressRegion)
    .filter((r): r is string => Boolean(r && r.length > 0))
    .join(' · ');
  const sectors = api.services.map((s) => s.name).join(' · ');

  return {
    id: api.aggregator_id,
    org: api.org_name || api.org_slug,
    registered: new Date(api.created_at).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }),
    coordinator,
    contact: {
      name: coordinator,
      mobile: api.contact?.phone ?? api.identity.phone ?? '',
      email: api.contact?.email ?? api.identity.email ?? '',
    },
    beneficiaries,
    address,
    geographies,
    sectors,
    network: {
      activeSeekers: 0,
      openRoles: 0,
      hires3mo: 0,
      matchRate: '—',
    },
    consent: {
      profileCreation: Boolean(api.consent?.value),
      sharing: false,
      notifications: false,
      analytics: false,
      marketing: false,
      retention: false,
      lastReviewed: new Date(api.updated_at).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
    },
  };
}

export const profileService: ProfileService = new ApiProfileService();
