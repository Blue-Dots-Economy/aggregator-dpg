import type {
  ParticipantBase,
  ParticipantFilter,
  ParticipantKind,
  Seeker,
  Provider,
  OpportunityProvider,
} from '../types';
import { SEEKERS, PROVIDERS, OPP_PROVIDERS } from '../data/mock';

export interface BlueDotsService {
  list(kind: ParticipantKind, filter?: ParticipantFilter): Promise<ParticipantBase[]>;
  seekers(filter?: ParticipantFilter): Promise<Seeker[]>;
  providers(filter?: ParticipantFilter): Promise<Provider[]>;
  oppProviders(filter?: ParticipantFilter): Promise<OpportunityProvider[]>;
}

function applyFilter<T extends ParticipantBase>(
  rows: T[],
  filter: ParticipantFilter | undefined,
): T[] {
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

class MockBlueDotsService implements BlueDotsService {
  async seekers(filter?: ParticipantFilter): Promise<Seeker[]> {
    return applyFilter(SEEKERS, filter);
  }

  async providers(filter?: ParticipantFilter): Promise<Provider[]> {
    return applyFilter(PROVIDERS, filter);
  }

  async oppProviders(filter?: ParticipantFilter): Promise<OpportunityProvider[]> {
    return applyFilter(OPP_PROVIDERS, filter);
  }

  async list(kind: ParticipantKind, filter?: ParticipantFilter): Promise<ParticipantBase[]> {
    if (kind === 'seeker') return this.seekers(filter);
    if (kind === 'provider') return this.providers(filter);
    return this.oppProviders(filter);
  }
}

export const blueDotsService: BlueDotsService = new MockBlueDotsService();
