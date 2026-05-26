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

export type ThemeMode = 'light' | 'dark';

interface ThemeModeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

/**
 * localStorage key for the user's chosen theme. Read by the inline
 * no-flash script in `app/layout.tsx` BEFORE React hydrates so the
 * initial paint matches the stored preference without a flash of
 * light theme on a dark-preferring user.
 */
export const THEME_STORAGE_KEY = 'bd:theme-mode';

/**
 * Applies the chosen mode to `<html>` (`class="dark"` or no class) and
 * persists the choice to localStorage. Provides `useThemeMode()` to
 * any client component that needs to read or toggle the active theme.
 *
 * Default: `light`. Honours a previously-stored preference on mount.
 */
export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('light');

  // Hydrate from localStorage on first client render. SSR markup is
  // always light to match the static no-flash script's default — once
  // we hit the client, sync with the persisted choice.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      setModeState(stored);
    }
  }, []);

  // Mirror the active mode into a class on <html> + persist.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (mode === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Storage may be disabled (private mode, quota). Theme still
      // applies in-memory for the session; we just can't persist it.
    }
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const toggle = useCallback(
    () => setModeState((prev) => (prev === 'light' ? 'dark' : 'light')),
    [],
  );

  const value = useMemo(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

/**
 * Read or change the active light/dark theme. Throws if used outside
 * the {@link ThemeModeProvider}.
 */
export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode must be used inside <ThemeModeProvider>');
  }
  return ctx;
}
