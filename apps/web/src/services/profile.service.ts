import type { AggregatorProfile } from '../types';

export interface ProfileService {
  get(): Promise<AggregatorProfile>;
  update(patch: Partial<AggregatorProfile>): Promise<AggregatorProfile>;
}

interface ProfileApiResponse {
  aggregator_id: string;
  org_slug: string;
  org_name: string;
  type: 'seeker' | 'provider';
  identity: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    email_verified: boolean;
    phone: string | null;
    phone_verified: boolean;
    active: boolean;
  };
  schema_version: number;
  data: Record<string, unknown>;
  consent: Record<string, unknown>;
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
  const fullName = [api.identity.first_name, api.identity.last_name]
    .filter((p): p is string => Boolean(p && p.length > 0))
    .join(' ');
  const data = api.data as Record<string, unknown>;
  const who = (data.who_i_am ?? {}) as Record<string, unknown>;
  const want = (data.what_i_want ?? {}) as Record<string, unknown>;
  const consentBlob = (api.consent ?? {}) as Record<string, unknown>;

  return {
    id: api.aggregator_id,
    org: api.org_name,
    registered: new Date(api.created_at).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }),
    coordinator: fullName,
    contact: {
      name: fullName,
      mobile: api.identity.phone ?? '',
      email: api.identity.email ?? '',
    },
    beneficiaries: arrayJoin(want.beneficiary_groups),
    address: pickString(who.address) ?? '',
    geographies: arrayJoin(want.geographies),
    sectors: arrayJoin(want.sectors),
    network: {
      activeSeekers: 0,
      openRoles: 0,
      hires3mo: 0,
      matchRate: '—',
    },
    consent: {
      profileCreation: Boolean(consentBlob.profile_creation),
      sharing: Boolean(consentBlob.data_sharing),
      notifications: Boolean(consentBlob.notifications),
      analytics: Boolean(consentBlob.analytics),
      marketing: Boolean(consentBlob.marketing),
      retention: Boolean(consentBlob.retention),
      lastReviewed: new Date(api.updated_at).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
    },
  };
}

function arrayJoin(v: unknown): string {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').join(' · ');
  }
  return '';
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export const profileService: ProfileService = new ApiProfileService();
