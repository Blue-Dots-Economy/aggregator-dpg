import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../lib/auth-context';

interface ProviderOptions {
  initialEntries?: string[];
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
  initialEntries,
  queryClient,
}: {
  children: ReactNode;
  initialEntries?: string[];
  queryClient?: QueryClient;
}) {
  const client = queryClient ?? makeQueryClient();
  const entries = initialEntries ?? ['/'];
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries}>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: ProviderOptions & RenderOptions,
): RenderResult {
  const { initialEntries, queryClient, ...rest } = options ?? {};
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders
        {...(initialEntries ? { initialEntries } : {})}
        {...(queryClient ? { queryClient } : {})}
      >
        {children}
      </AllProviders>
    ),
    ...rest,
  });
}
