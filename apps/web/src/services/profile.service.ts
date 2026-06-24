import type { AggregatorProfile } from '../types';
import { jsonFetch } from './http';

/**
 * Server-side patch shape mirrored from the API's
 * `ProfileUpdateBodySchema`. The API splits writes by destination:
 *   - `aggregator.*` → `aggregators` row (Beckn contact / locations live here)
 *   - `profile.*`    → `aggregator_profile` row (post-login extras)
 */
export interface ProfileEditPayload {
  aggregator?: {
    name?: string;
    url?: string | null;
    contact?: {
      name: string;
      phone: string;
      email: string;
      alternatePhone?: string;
      company?: string;
      gstNumber?: string;
    };
    locations?: Array<{
      geo: { type: string; coordinates?: unknown };
      address?: Record<string, string | undefined>;
    }>;
  };
  profile?: {
    contact_name?: string | null;
    personas?: Array<{ id: string; name: string }>;
    services?: Array<{ id: string; name: string }>;
  };
}

export interface ProfileService {
  get(): Promise<AggregatorProfile>;
  update(patch: Partial<AggregatorProfile>): Promise<AggregatorProfile>;
  edit(payload: ProfileEditPayload): Promise<AggregatorProfile>;
  /** Raw read of the merged API response (pre-mapping) for edit pre-fill. */
  getRaw(): Promise<ProfileApiResponse>;
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
export interface ProfileApiResponse {
  aggregator_id: string;
  org_slug: string;
  org_name: string;
  actor_type: 'aggregator' | 'seeker' | 'provider';
  // Domain id the aggregator is scoped to. Comes from the network config
  // (networks.json domains), so not limited to seeker/provider — e.g.
  // orange_dot exposes tourist / practitioner.
  type: string | null;
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
  identity?: {
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
    const body = await this.getRaw();
    return mapToAggregatorProfile(body);
  }

  async getRaw(): Promise<ProfileApiResponse> {
    return jsonFetch<ProfileApiResponse>('/api/aggregator/profile/me');
  }

  async update(patch: Partial<AggregatorProfile>): Promise<AggregatorProfile> {
    // Legacy display-shape patch (kept for callers that haven't migrated to
    // `edit()`). Returns the freshly fetched profile so React Query stays
    // consistent.
    void patch;
    return this.get();
  }

  async edit(payload: ProfileEditPayload): Promise<AggregatorProfile> {
    const data = await jsonFetch<ProfileApiResponse>('/api/aggregator/profile/me', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return mapToAggregatorProfile(data);
  }
}

function mapToAggregatorProfile(api: ProfileApiResponse): AggregatorProfile {
  // Display the Beckn contact.name as the coordinator. Fall back to KC
  // identity (firstName + lastName) when the contact has not been set, then
  // to the profile's separate contact_name label.
  const identityFull = [api.identity?.first_name, api.identity?.last_name]
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

  const fmtDate = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  return {
    id: api.aggregator_id,
    org: api.org_name || '',
    registered: fmtDate(api.created_at),
    coordinator,
    contact: {
      name: coordinator,
      mobile: api.contact?.phone ?? api.identity?.phone ?? '',
      email: api.contact?.email ?? api.identity?.email ?? '',
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
      lastReviewed: fmtDate(api.updated_at),
    },
  };
}

export const profileService: ProfileService = new ApiProfileService();
