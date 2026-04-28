'use client';

import { useQuery } from '@tanstack/react-query';
import { blueDotsService } from '../services/blue-dots.service';
import type { ParticipantFilter } from '../types';

export function useSeekers(filter?: ParticipantFilter) {
  return useQuery({
    queryKey: ['blue-dots', 'seekers', filter],
    queryFn: () => blueDotsService.seekers(filter),
  });
}

export function useProviders(filter?: ParticipantFilter) {
  return useQuery({
    queryKey: ['blue-dots', 'providers', filter],
    queryFn: () => blueDotsService.providers(filter),
  });
}

export function useOppProviders(filter?: ParticipantFilter) {
  return useQuery({
    queryKey: ['blue-dots', 'opp-providers', filter],
    queryFn: () => blueDotsService.oppProviders(filter),
  });
}
