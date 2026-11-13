'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './theme-provider';
import { ThemeModeProvider } from './theme-mode';
import { retryUnlessShapeError } from '../services/http';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: retryUnlessShapeError,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ThemeModeProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </ThemeModeProvider>
    </QueryClientProvider>
  );
}
