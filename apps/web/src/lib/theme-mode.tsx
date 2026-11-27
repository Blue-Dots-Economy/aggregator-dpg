'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { subscribeNever } from '@/lib/subscribe-never';

export type ThemeMode = 'light' | 'dark';

interface ThemeModeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

/**
 * localStorage key for the user's chosen theme.
 *
 * Also read by the inline script in `app/layout.tsx` before hydration, so the
 * first paint uses the stored theme.
 */
export const THEME_STORAGE_KEY = 'bd:theme-mode';

/**
 * Reads the stored theme choice.
 *
 * @returns The stored mode, or `null` when none is stored, it is not a mode, or storage is unavailable.
 */
function readStoredMode(): ThemeMode | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    // Storage may be unavailable; the default applies.
    return null;
  }
}

/**
 * Applies the light/dark mode to `<html>` and saves the user's choice to localStorage.
 *
 * Defaults to `light`; reads a stored preference after hydration. Storage is
 * written only when the user picks a theme.
 *
 * @param children - Subtree that may call `useThemeMode`.
 */
export function ThemeModeProvider({ children }: { children: ReactNode }) {
  // Server markup is always light; the client reads the stored choice.
  const stored = useSyncExternalStore(subscribeNever, readStoredMode, () => null);
  const [chosen, setChosen] = useState<ThemeMode | null>(null);
  const mode: ThemeMode = chosen ?? stored ?? 'light';

  // Mirror the mode onto `<html>`. While neither a choice nor a stored value
  // is known (the hydration render), leave the class the inline script set.
  const known = chosen !== null || stored !== null;
  useEffect(() => {
    if (!known) return;
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, [known, mode]);

  /** Applies and saves a theme the user picked. */
  const choose = useCallback((next: ThemeMode) => {
    setChosen(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable; the theme still applies for this session.
    }
  }, []);
  const setMode = choose;
  const toggle = useCallback(() => choose(mode === 'light' ? 'dark' : 'light'), [choose, mode]);

  const value = useMemo(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

/**
 * Reads or changes the active light/dark theme.
 *
 * @returns The mode and its setters.
 * @throws {Error} If used outside {@link ThemeModeProvider}.
 */
export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) {
    throw new Error('useThemeMode must be used inside <ThemeModeProvider>');
  }
  return ctx;
}
