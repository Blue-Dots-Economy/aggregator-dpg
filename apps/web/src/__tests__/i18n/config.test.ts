import { describe, it, expect, afterEach } from 'vitest';
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  getEnabledLocales,
  resolveLocale,
} from '@/i18n/config';

const ENV_KEY = 'NEXT_PUBLIC_ENABLED_LANGUAGES';

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('i18n config', () => {
  it('supports en, kn, hi with en as default', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'kn', 'hi']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('isSupportedLocale guards unknown/empty values', () => {
    expect(isSupportedLocale('kn')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
  });

  it('getEnabledLocales returns all supported when env unset', () => {
    expect(getEnabledLocales()).toEqual(['en', 'kn', 'hi']);
  });

  it('getEnabledLocales honours the env list and order, always including en', () => {
    process.env[ENV_KEY] = 'hi,kn';
    expect(getEnabledLocales()).toEqual(['en', 'hi', 'kn']);
  });

  it('getEnabledLocales drops unsupported codes and trims whitespace', () => {
    process.env[ENV_KEY] = 'en, fr , kn';
    expect(getEnabledLocales()).toEqual(['en', 'kn']);
  });

  it('resolveLocale prefers a valid enabled cookie', () => {
    expect(resolveLocale('hi', 'en-US,en;q=0.9')).toBe('hi');
  });

  it('resolveLocale negotiates from Accept-Language when no cookie', () => {
    expect(resolveLocale(undefined, 'kn-IN,kn;q=0.9,en;q=0.8')).toBe('kn');
  });

  it('resolveLocale falls back to default for unknown cookie + header', () => {
    expect(resolveLocale('fr', 'fr-FR,fr;q=0.9')).toBe('en');
  });
});
