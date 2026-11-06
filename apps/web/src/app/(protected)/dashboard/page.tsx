'use client';

/**
 * Coordinator dashboard page (`web` app).
 */
import { useProfileRaw } from '@/hooks/useProfile';
import { DashboardContent, DashboardLoadingFrame } from './_components/DashboardContent';

/**
 * Waits for the coordinator's profile, then renders the dashboard for its domain.
 *
 * Waiting means no tab reads the wrong domain.
 */
export default function DashboardPageRoot() {
  const rawProfile = useProfileRaw();
  const profileType = rawProfile.data?.type;
  if (!profileType) {
    return <DashboardLoadingFrame />;
  }
  return <DashboardContent aggregatorType={profileType} />;
}
