'use client';

/**
 * Client view of the coordinator dashboard (`web` app).
 *
 * The dashboard reads its data and keeps its filters on the client, so this
 * view is the client boundary; the page above it is a Server Component.
 */
import { useProfileRaw } from '@/hooks/useProfile';
import { DashboardContent, DashboardLoadingFrame } from './DashboardContent';

/**
 * Waits for the coordinator's profile, then renders the dashboard for its domain.
 *
 * Waiting means no tab reads the wrong domain.
 */
export function DashboardView() {
  const rawProfile = useProfileRaw();
  const profileType = rawProfile.data?.type;
  if (!profileType) {
    return <DashboardLoadingFrame />;
  }
  return <DashboardContent aggregatorType={profileType} />;
}
