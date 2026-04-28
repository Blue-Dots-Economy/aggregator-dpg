import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { makeQueryClient } from './test-utils';

function renderApp(initialEntries: string[]) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('App routing', () => {
  it('redirects unauthenticated root to login welcome', async () => {
    renderApp(['/']);
    await waitFor(() => {
      expect(screen.getByText(/Welcome back/i)).toBeInTheDocument();
    });
  });

  it('redirects unauthenticated /blue-dots to login welcome', async () => {
    renderApp(['/blue-dots']);
    await waitFor(() => {
      expect(screen.getByText(/Welcome back/i)).toBeInTheDocument();
    });
  });

  it('signs the user in via existing-user path and lands on /blue-dots', async () => {
    const user = userEvent.setup();
    renderApp(['/login']);

    const existing = screen.getByText(/Existing user/i).closest('button');
    expect(existing).not.toBeNull();
    await user.click(existing!);

    const select = await screen.findByRole('combobox');
    await user.selectOptions(select, 'TRRAIN');

    const password = screen.getByPlaceholderText(/•/);
    await user.type(password, 'password');

    await user.click(screen.getByRole('button', { name: /^Log in$/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /My Blue Dots/i })).toBeInTheDocument();
    });
  });
});
