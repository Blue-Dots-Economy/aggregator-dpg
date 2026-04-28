import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { OnboardingRoute } from '../../routes/onboarding';
import { renderWithProviders } from '../test-utils';

describe('<OnboardingRoute />', () => {
  it('renders the onboarding header and CSV upload zone', async () => {
    renderWithProviders(<OnboardingRoute />, { initialEntries: ['/onboarding'] });
    expect(screen.getByRole('heading', { name: /^Onboarding$/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Add participants/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Drag your CSV here/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Your Registration Links/i)).toBeInTheDocument();
    });
  });
});
