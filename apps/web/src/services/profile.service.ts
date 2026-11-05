import type { AggregatorProfile } from '../types';
import { z } from 'zod';
import { jsonFetch } from './http';

export interface ProfileService {
  get(): Promise<AggregatorProfile>;
  /** Raw read of the API response (pre-mapping) for form pre-fill. */
  getRaw(): Promise<ProfileApiResponse>;
}

/**
 * Shape of `contact` on `GET /v1/aggregators/profile/me`.
 *
 * Mirrors `BecknContactSchema` in `@aggregator-dpg/shared-primitives/beckn`.
 */
const BecknContactSchema = z.object({
  name: z.string(),
  phone: z.string(),
  email: z.string(),
  alternatePhone: z.string().optional(),
  company: z.string().optional(),
  gstNumber: z.string().optional(),
});

/** One profile location. Kept whole, because the profile form renders it as received. */
const BecknLocationSchema = z
  .object({
    geo: z.object({ type: z.string(), coordinates: z.unknown().optional() }).passthrough(),
    address: z.record(z.string().optional()).optional(),
  })
  .passthrough();

/** Response of `GET /v1/aggregators/profile/me`, plus the Keycloak `identity` fragment. */
export const ProfileApiResponseSchema = z.object({
  aggregator_id: z.string(),
  org_slug: z.string(),
  org_name: z.string(),
  actor_type: z.enum(['aggregator', 'seeker', 'provider']),
  // Domain id from the network config; any network domain is possible.
  type: z.string().nullable(),
  url: z.string().nullable(),
  contact: BecknContactSchema,
  locations: z.array(BecknLocationSchema),
  // From the consent ledger; null when it has no registration row.
  consent: z
    .object({ value: z.boolean(), given_at: z.string(), valid_till: z.string() })
    .nullable(),
  status: z.enum(['pending', 'active', 'inactive', 'retired']),
  identity: z
    .object({
      first_name: z.string().nullable(),
      last_name: z.string().nullable(),
      email: z.string().nullable(),
      email_verified: z.boolean(),
      phone: z.string().nullable(),
      phone_verified: z.boolean(),
      active: z.boolean(),
    })
    .optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProfileApiResponse = z.infer<typeof ProfileApiResponseSchema>;

class ApiProfileService implements ProfileService {
  async get(): Promise<AggregatorProfile> {
    const body = await this.getRaw();
    return mapToAggregatorProfile(body);
  }

  async getRaw(): Promise<ProfileApiResponse> {
    return jsonFetch('/api/aggregator/profile/me', ProfileApiResponseSchema);
  }
}

function mapToAggregatorProfile(api: ProfileApiResponse): AggregatorProfile {
  // Use contact.name, else the Keycloak first and last name.
  const identityFull = [api.identity?.first_name, api.identity?.last_name]
    .filter((p): p is string => Boolean(p && p.length > 0))
    .join(' ');
  const coordinator = api.contact?.name || identityFull;

  // First location's address as one line.
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

  // Older rows have `addressRegion`; newer rows only have `streetAddress`.
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
    // Not rendered anywhere; kept to satisfy the display type.
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
