'use client';

import { useQuery } from '@tanstack/react-query';
import { onboardingService } from '../services/onboarding.service';

export function useRegistrationLinks(kind: 'seeker' | 'provider') {
  return useQuery({
    queryKey: ['onboarding', 'links', kind],
    queryFn: () => onboardingService.links(kind),
  });
}
