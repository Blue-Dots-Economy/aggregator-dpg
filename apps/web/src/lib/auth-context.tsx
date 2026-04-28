'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '../types';
import { authService } from '../services/auth.service';

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isHydrated: boolean;
  signIn: (input: { org: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
}

const STORAGE_KEY = 'bd-portal-user';

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        setUser(JSON.parse(raw) as User);
      }
    } catch {
      // ignore corrupt storage
    }
    setIsHydrated(true);
  }, []);

  const signIn = useCallback(async (input: { org: string; password: string }) => {
    const u = await authService.login(input);
    setUser(u);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
  }, []);

  const signOut = useCallback(async () => {
    await authService.logout();
    setUser(null);
    window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isHydrated,
      signIn,
      signOut,
    }),
    [user, isHydrated, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
