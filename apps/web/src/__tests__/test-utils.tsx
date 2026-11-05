import type { ReactElement, ReactNode } from 'react';
import {
  fireEvent,
  render,
  screen,
  type RenderOptions,
  type RenderResult,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../lib/auth-context';

interface ProviderOptions {
  queryClient?: QueryClient;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function AllProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  const client = queryClient ?? makeQueryClient();
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: ProviderOptions & RenderOptions,
): RenderResult {
  const { queryClient, ...rest } = options ?? {};
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders {...(queryClient ? { queryClient } : {})}>{children}</AllProviders>
    ),
    ...rest,
  });
}

/**
 * Opens a styled `Select` dropdown and picks the option with the given name.
 *
 * @param trigger - The dropdown's combobox button.
 * @param name - The option's accessible name.
 */
export async function chooseOption(trigger: HTMLElement, name: string | RegExp): Promise<void> {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('option', { name }));
}
