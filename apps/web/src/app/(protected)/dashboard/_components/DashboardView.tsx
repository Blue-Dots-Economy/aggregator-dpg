'use client';

/**
 * Client view of the coordinator dashboard (`web` app).
 *
 * The dashboard reads its data and keeps its filters on the client, so this
 * view is the client boundary; the page above it is a Server Component.
 */
import { useProfileRaw } from '@/hooks/useProfile';
import { DashboardContent, DashboardErrorFrame, DashboardLoadingFrame } from './DashboardContent';

/**
 * Waits for the coordinator's profile, then renders the dashboard for its domain.
 *
 * Waiting means no tab reads the wrong domain. A failed profile read shows an
 * error with a retry.
 */
export function DashboardView() {
  const rawProfile = useProfileRaw();
  const profileType = rawProfile.data?.type;
  if (profileType) {
    return <DashboardContent aggregatorType={profileType} />;
  }
  if (rawProfile.isError) {
    return (
      <DashboardErrorFrame
        onRetry={() => {
          void rawProfile.refetch();
        }}
      />
    );
  }
  return <DashboardLoadingFrame />;
}
