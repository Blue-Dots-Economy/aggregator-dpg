'use client';

import { useQuery } from '@tanstack/react-query';
import { profileService } from '../services/profile.service';

const QUERY_KEY = ['profile'] as const;
const RAW_QUERY_KEY = ['profile', 'raw'] as const;

export function useProfile() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => profileService.get(),
  });
}

/**
 * Raw API-shape profile (pre-display-mapping). Used by the edit form to
 * pre-populate fields from the canonical Beckn shape instead of guessing
 * back from the display-mapped AggregatorProfile.
 */
export function useProfileRaw() {
  return useQuery({
    queryKey: RAW_QUERY_KEY,
    queryFn: () => profileService.getRaw(),
  });
}
