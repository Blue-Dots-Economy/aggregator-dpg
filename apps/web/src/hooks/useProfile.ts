'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { profileService, type ProfileEditPayload } from '../services/profile.service';
import type { AggregatorProfile } from '../types';

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

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AggregatorProfile>) => profileService.update(patch),
    onSuccess: (data) => {
      qc.setQueryData(QUERY_KEY, data);
    },
  });
}

export function useEditProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ProfileEditPayload) => profileService.edit(payload),
    onSuccess: () => {
      // The PATCH response is a slim subset (no identity / created_at /
      // org_name). Refetch the full GET so the display card shows the
      // canonical merged shape, not a partial mapping.
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: RAW_QUERY_KEY });
    },
  });
}
