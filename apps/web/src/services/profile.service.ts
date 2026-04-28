import type { AggregatorProfile } from '../types';
import { AGGREGATOR_PROFILE } from '../data/mock';

export interface ProfileService {
  get(): Promise<AggregatorProfile>;
  update(patch: Partial<AggregatorProfile>): Promise<AggregatorProfile>;
}

class MockProfileService implements ProfileService {
  private profile: AggregatorProfile = AGGREGATOR_PROFILE;

  async get(): Promise<AggregatorProfile> {
    return this.profile;
  }

  async update(patch: Partial<AggregatorProfile>): Promise<AggregatorProfile> {
    this.profile = { ...this.profile, ...patch };
    return this.profile;
  }
}

export const profileService: ProfileService = new MockProfileService();
