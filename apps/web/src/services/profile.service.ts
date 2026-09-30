import type { AggregatorProfile } from '../types';
import { jsonFetch } from './http';

export interface ProfileService {
  get(): Promise<AggregatorProfile>;
  /** Raw read of the API response (pre-mapping) for form pre-fill. */
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

/**
 * `GET /v1/aggregators/profile/me` response shape — the `aggregators` row
 * flattened to the top level, plus the Keycloak-derived `identity` fragment.
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
  identity?: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    email_verified: boolean;
    phone: string | null;
    phone_verified: boolean;
    active: boolean;
  };
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
}

function mapToAggregatorProfile(api: ProfileApiResponse): AggregatorProfile {
  // Display the Beckn contact.name as the coordinator, falling back to the KC
  // identity (firstName + lastName) when the contact has not been set.
  const identityFull = [api.identity?.first_name, api.identity?.last_name]
    .filter((p): p is string => Boolean(p && p.length > 0))
    .join(' ');
  const coordinator = api.contact?.name || identityFull;

  // Render the first location's postal address as a single line for the
  // dashboard card.
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

  // `addressRegion` only exists on rows registered before the address became a
  // single autocomplete field (#810), so fall back to the free-text address —
  // the only location text a current row carries. Without the fallback this
  // renders blank for every new registration.
  const geographies = (api.locations ?? [])
    .map((loc) => loc.address?.addressRegion || loc.address?.streetAddress)
    .filter((r): r is string => Boolean(r && r.length > 0))
    .join(' · ');

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
    // `beneficiaries` / `sectors` were fed by the removed `aggregator_profile`
    // personas + services. No component renders them; kept on the display type
    // so the dashboard shape is unchanged.
    beneficiaries: '',
    address,
    geographies,
    sectors: '',
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
