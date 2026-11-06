import type { JSX } from 'react';
import { OnboardingView } from './_components/OnboardingView';

/**
 * Onboarding overview page (Server Component).
 *
 * The view reads its data in the browser through TanStack Query.
 */
export default function OnboardingPage(): JSX.Element {
  return <OnboardingView />;
}
