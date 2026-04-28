'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { profileService } from '../services/profile.service';
import type { AggregatorProfile } from '../types';

const QUERY_KEY = ['profile'] as const;

export function useProfile() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => profileService.get(),
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
