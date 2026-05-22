/**
 * Blue-dots dashboard service.
 *
 * Reads signalstack-backed profile items via the BFF proxy and maps them
 * into the existing ParticipantBase / Seeker / Provider / OpportunityProvider
 * shape consumed by the dashboard. Columns that signalstack does not store
 * (Applied / Pre-shortlisted / Status / Recommended Action) are filled with
 * zero / safe defaults — the dashboard already renders blanks gracefully.
 */

import type {
  OpportunityProvider,
  ParticipantBase,
  ParticipantFilter,
  ParticipantKind,
  Provider,
  Seeker,
} from '../types';
import { jsonFetch } from './http';

/**
 * Query for the signalstack-backed aggregator dashboard.
 *
 * `status` is intentionally optional — the dashboard's default render
 * issues the call WITHOUT a status param so the rollup returns full
 * by-status counts and the participants list is unfiltered. The page
 * refetches with `status` set only when the user explicitly picks a
 * server-side filter chip.
 */
export interface BlueDotsDashboardQuery {
  domain?: 'seeker' | 'provider';
  page?: number;
  limit?: number;
  status?: string;
}

/**
 * Pre-computed rollup of participant counts returned alongside the
 * dashboard page. `by_status` is an open map — signalstack adds status
 * keys without bumping a version, so consumers MUST tolerate unknown
 * keys instead of pinning an enum.
 */
export interface BlueDotsDashboardRollup {
  participants_total: number;
  by_status: Record<string, number>;
  applications_pending: number;
  applications_accepted: number;
  applications_rejected: number;
}

/**
 * Signalstack-side metadata about the cached rollup. Surfaced verbatim
 * so the dashboard can display a "last updated" hint and decide whether
 * the response is fresh or cache-served.
 */
export interface BlueDotsDashboardMetadata {
  last_computed_at: string;
  ttl_seconds: number;
  refreshed: boolean;
}

/**
 * Full payload of the dashboard fetch. `participants` is open-shape
 * because signalstack owns the per-row schema — consumers decode only
 * the keys they care about.
 */
export interface BlueDotsDashboardPage {
  rollup: BlueDotsDashboardRollup;
  participants: Array<Record<string, unknown>>;
  next_cursor: string | null;
  total_matching: number;
  metadata: BlueDotsDashboardMetadata;
}

export interface BlueDotsService {
  list(kind: ParticipantKind, filter?: ParticipantFilter): Promise<ParticipantBase[]>;
  seekers(filter?: ParticipantFilter): Promise<Seeker[]>;
  providers(filter?: ParticipantFilter): Promise<Provider[]>;
  oppProviders(filter?: ParticipantFilter): Promise<OpportunityProvider[]>;
  /**
   * Fetch the signalstack-backed aggregator dashboard payload.
   *
   * Call without `status` for the default landing view (full rollup +
   * unfiltered participants); call again with `status` set when the
   * user selects a filter chip so signalstack returns the server-side
   * filtered slice.
   */
  dashboard(query?: BlueDotsDashboardQuery): Promise<BlueDotsDashboardPage>;
}

interface SignalStackItem {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  item_latitude: number | null;
  item_longitude: number | null;
  aggregator_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SignalStackItemList {
  meta: { total: number; limit: number; offset: number };
  items: SignalStackItem[];
}

const ZERO_STATS = { total: 0, shortlisted: 0, accepted: 0, rejected: 0, pending: 0 };

class HttpBlueDotsService implements BlueDotsService {
  async seekers(filter?: ParticipantFilter): Promise<Seeker[]> {
    const raw = await this.fetchDomain('seeker');
    return this.applyFilter(
      raw.map((it) => this.toSeeker(it)),
      filter,
    );
  }

  async providers(filter?: ParticipantFilter): Promise<Provider[]> {
    const raw = await this.fetchDomain('provider');
    return this.applyFilter(
      raw.map((it) => this.toProvider(it)),
      filter,
    );
  }

  async oppProviders(filter?: ParticipantFilter): Promise<OpportunityProvider[]> {
    // Signalstack has no dedicated opp-provider item_type yet — provider rows
    // cover the dashboard's data needs for now. Switch to a separate
    // item_type when the schema lands.
    const raw = await this.fetchDomain('provider');
    return this.applyFilter(
      raw.map((it) => this.toProvider(it)),
      filter,
    );
  }

  async list(kind: ParticipantKind, filter?: ParticipantFilter): Promise<ParticipantBase[]> {
    if (kind === 'seeker') return this.seekers(filter);
    if (kind === 'provider') return this.providers(filter);
    return this.oppProviders(filter);
  }

  private async fetchDomain(domain: 'seeker' | 'provider'): Promise<SignalStackItem[]> {
    // Signalstack's FetchItemsBodySchema caps limit at 100. Match that here.
    const url = `/api/blue-dots/items?domain=${domain}&limit=100`;
    const payload = await jsonFetch<SignalStackItemList>(url);
    return payload.items ?? [];
  }

  async dashboard(query?: BlueDotsDashboardQuery): Promise<BlueDotsDashboardPage> {
    const params = new URLSearchParams();
    params.set('domain', query?.domain ?? 'seeker');
    if (query?.page !== undefined) params.set('page', String(query.page));
    if (query?.limit !== undefined) params.set('limit', String(query.limit));
    // Skip `status` when the caller did not select a filter chip — the
    // default landing render needs the full rollup + unfiltered list, so
    // the BFF/API must NOT see a `status` param in that mode.
    if (query?.status) params.set('status', query.status);
    const url = `/api/blue-dots/dashboard?${params.toString()}`;
    return jsonFetch<BlueDotsDashboardPage>(url);
  }

  private toSeeker(item: SignalStackItem): Seeker {
    const state = item.item_state ?? {};
    const name = pickString(state, 'name') ?? 'Unknown';
    const city = pickString(state, 'location') ?? '';
    return {
      id: item.item_id,
      name,
      city,
      joined: formatDate(item.created_at),
      avatar: initials(name),
      profile: {
        title: pickString(state, 'nameOfJobRolesInterestedIn') ?? '',
        exp: pickString(state, 'workExperienceYearsConditional') ?? '',
        verified: false,
        complete: completeness(state),
      },
      applied: { ...ZERO_STATS },
      pre: { ...ZERO_STATS },
      status: 'active',
      last: relative(item.updated_at),
    };
  }

  private toProvider(item: SignalStackItem): Provider {
    const state = item.item_state ?? {};
    const name = pickString(state, 'jobProviderName') ?? pickString(state, 'name') ?? 'Unknown';
    const city = pickString(state, 'jobProviderLocation') ?? pickString(state, 'location') ?? '';
    const role = pickString(state, 'role') ?? '';
    const nature = pickString(state, 'natureOfJob') ?? '';
    return {
      id: item.item_id,
      name,
      city,
      joined: formatDate(item.created_at),
      avatar: initials(name),
      profile: {
        title: role,
        exp: nature,
        verified: false,
        complete: completeness(state),
      },
      applied: { ...ZERO_STATS },
      pre: { ...ZERO_STATS },
      status: 'active',
      last: relative(item.updated_at),
      role: role && nature ? `${role} · ${nature}` : role || nature,
    };
  }

  private applyFilter<T extends ParticipantBase>(rows: T[], filter?: ParticipantFilter): T[] {
    if (!filter) return rows;
    return rows.filter((r) => {
      if (filter.status && r.status !== filter.status) return false;
      if (filter.city && !r.city.toLowerCase().includes(filter.city.toLowerCase())) return false;
      if (filter.search) {
        const q = filter.search.toLowerCase();
        const haystack = `${r.name} ${r.id} ${r.profile.title}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }
}

function pickString(state: Record<string, unknown>, key: string): string | null {
  const v = state[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function relative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Crude profile completeness ratio based on the count of non-empty string
 * fields in item_state. Avoids hard-coding any schema and degrades safely
 * for unknown shapes — the dashboard only uses it for the progress bar.
 */
function completeness(state: Record<string, unknown>): number {
  const entries = Object.entries(state);
  if (entries.length === 0) return 0;
  const filled = entries.filter(([, v]) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }).length;
  return Math.round((filled / entries.length) * 100);
}

export const blueDotsService: BlueDotsService = new HttpBlueDotsService();
