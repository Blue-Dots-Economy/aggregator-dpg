/**
 * Unit tests for SIGNALS_UI_URLS parsing.
 *
 * Exercised through the exported pure function rather than by mutating
 * process.env, because `config.ts` snapshots the environment at module load.
 */
import { describe, it, expect } from 'vitest';
import { parseSignalsUiUrls } from './config.js';

describe('parseSignalsUiUrls', () => {
  it('parses comma-separated domain=url pairs', () => {
    expect(
      parseSignalsUiUrls(
        'seeker=https://signals-seeker.example/auth/login,provider=https://signals-provider.example/auth/login',
      ).urls,
    ).toEqual({
      seeker: 'https://signals-seeker.example/auth/login',
      provider: 'https://signals-provider.example/auth/login',
    });
  });

  it('returns an empty map for unset or empty input', () => {
    expect(parseSignalsUiUrls(undefined).urls).toEqual({});
    expect(parseSignalsUiUrls('').urls).toEqual({});
    expect(parseSignalsUiUrls('   ').urls).toEqual({});
  });

  it('splits on the first = only so query strings survive', () => {
    expect(parseSignalsUiUrls('seeker=https://s.example/auth/login?a=1&b=2').urls).toEqual({
      seeker: 'https://s.example/auth/login?a=1&b=2',
    });
  });

  it('tolerates Helm quote wrapping, newlines and stray whitespace', () => {
    expect(
      parseSignalsUiUrls(
        '"seeker=https://s.example/auth/login\n provider=https://p.example/auth/login "',
      ).urls,
    ).toEqual({
      seeker: 'https://s.example/auth/login',
      provider: 'https://p.example/auth/login',
    });
  });

  it('skips a malformed entry and warns, keeping the valid ones', () => {
    const result = parseSignalsUiUrls(
      'seeker=https://s.example/auth/login,provider=not-a-url,=https://x.example,Bad=https://y.example',
    );
    expect(result.urls).toEqual({ seeker: 'https://s.example/auth/login' });
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join(' ')).toContain('provider');
  });

  it('rejects non-http(s) schemes', () => {
    expect(parseSignalsUiUrls('seeker=javascript:alert(1)').urls).toEqual({});
  });

  it('last entry wins on a duplicate domain key', () => {
    expect(
      parseSignalsUiUrls('seeker=https://a.example/auth/login,seeker=https://b.example/auth/login')
        .urls,
    ).toEqual({
      seeker: 'https://b.example/auth/login',
    });
  });
});
