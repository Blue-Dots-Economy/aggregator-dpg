import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { LoginRoute } from '../../routes/login';
import { renderWithProviders } from '../test-utils';

describe('<LoginRoute />', () => {
  it('renders the welcome step with both choice cards', () => {
    renderWithProviders(<LoginRoute />, { initialEntries: ['/login'] });
    expect(screen.getByText(/Welcome back/i)).toBeInTheDocument();
    expect(screen.getByText(/Existing user/i)).toBeInTheDocument();
    expect(screen.getByText(/Become a member/i)).toBeInTheDocument();
  });
});
