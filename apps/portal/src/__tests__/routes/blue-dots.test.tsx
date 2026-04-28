import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { BlueDotsRoute } from '../../routes/blue-dots';
import { renderWithProviders } from '../test-utils';

describe('<BlueDotsRoute />', () => {
  it('renders the My Blue Dots header and seeker rows after fetch', async () => {
    renderWithProviders(<BlueDotsRoute />, { initialEntries: ['/blue-dots'] });
    expect(screen.getByRole('heading', { name: /My Blue Dots/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Priya Hiremath')).toBeInTheDocument();
    });
  });
});
