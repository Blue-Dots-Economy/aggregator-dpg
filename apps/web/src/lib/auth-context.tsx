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
import { can as canWith } from './capabilities';

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isHydrated: boolean;
  signOut: () => Promise<void>;
  supportEnabled: boolean;
  /** The caller's capabilities; null when access control is off (nothing hidden). */
  capabilities: readonly string[] | null;
  /** Whether a feature needing `capability` should be shown. */
  can: (capability: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  initialUser?: User | null;
  /**
   * Whether contact-support is available (`SUPPORT_EMAIL` configured
   * upstream). Fetched server-side by the protected layout via
   * `GET /v1/support/config`; defaults to `false` so the entry point stays
   * hidden until proven enabled.
   */
  supportEnabled?: boolean;
  /**
   * The caller's capabilities from `GET /v1/user/read/me` (RBAC). Null or
   * absent: access control is off, so nothing is hidden.
   */
  capabilities?: readonly string[] | null;
}

/**
 * Provides the active user to client components. Consumes a session snapshot
 * passed from the server layout — does not fetch on its own.
 *
 * @param props - `children` plus an optional `initialUser` and `supportEnabled` from the server.
 */
export function AuthProvider({
  children,
  initialUser = null,
  supportEnabled = false,
  capabilities = null,
}: AuthProviderProps) {
  const signOut = useCallback(async () => {
    window.location.href = '/api/auth/logout';
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: initialUser,
      isAuthenticated: initialUser !== null,
      isHydrated: true,
      signOut,
      supportEnabled,
      capabilities,
      can: (capability: string) => canWith(capabilities, capability),
    }),
    [initialUser, signOut, supportEnabled, capabilities],
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

/**
 * Returns the capability check for client components. Outside an
 * `AuthProvider` (or with access control off) everything is allowed: hiding is
 * a convenience, the API decides.
 *
 * @returns `can(capability)`.
 */
export function useCan(): (capability: string) => boolean {
  const ctx = useContext(AuthContext);
  return ctx ? ctx.can : () => true;
}
