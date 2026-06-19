'use client';

/**
 * Client-side auth context.
 *
 * Hydrated from a server-side `getSession()` snapshot via the `initialUser`
 * prop on the protected layout. The browser never sees access tokens — only
 * the public claims surfaced here.
 *
 * `signOut()` redirects to the BFF logout endpoint, which destroys the Redis
 * session, clears the cookie, and bounces through Keycloak's end-session.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isHydrated: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  initialUser?: User | null;
}

/**
 * Provides the active user to client components. Consumes a session snapshot
 * passed from the server layout — does not fetch on its own.
 *
 * @param props - `children` plus an optional `initialUser` from the server.
 */
export function AuthProvider({ children, initialUser = null }: AuthProviderProps) {
  const signOut = useCallback(async () => {
    window.location.href = '/api/auth/logout';
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: initialUser,
      isAuthenticated: initialUser !== null,
      isHydrated: true,
      signOut,
    }),
    [initialUser, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Reads the active session in client components.
 *
 * @returns The current `user` plus auth-state booleans and `signOut`.
 * @throws If called outside an `AuthProvider`.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
