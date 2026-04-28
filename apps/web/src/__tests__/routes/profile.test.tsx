import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { ProfileRoute } from '../../routes/profile';
import { renderWithProviders } from '../test-utils';

describe('<ProfileRoute />', () => {
  it('renders the aggregator profile header and switches tabs', async () => {
    renderWithProviders(<ProfileRoute />, { initialEntries: ['/profile'] });
    expect(screen.getByRole('heading', { name: /Aggregator Profile/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('TRRAIN')).toBeInTheDocument();
    });
  });
});
