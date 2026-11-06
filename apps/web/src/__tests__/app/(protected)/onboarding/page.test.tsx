/**
 * Tests for the onboarding Server Component pages: each renders its client view.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/app/(protected)/onboarding/_components/OnboardingView', () => ({
  OnboardingView: () => <div data-testid="onboarding-view" />,
}));
vi.mock('@/app/(protected)/onboarding/_components/RegistrationLinksView', () => ({
  RegistrationLinksView: () => <div data-testid="registration-links-view" />,
}));

import OnboardingPage from '@/app/(protected)/onboarding/page';
import RegistrationLinksPage from '@/app/(protected)/onboarding/links/page';

describe('onboarding pages', () => {
  it('renders the overview view', () => {
    render(<OnboardingPage />);
    expect(screen.getByTestId('onboarding-view')).toBeInTheDocument();
  });

  it('renders the registration links view', () => {
    render(<RegistrationLinksPage />);
    expect(screen.getByTestId('registration-links-view')).toBeInTheDocument();
  });
});
