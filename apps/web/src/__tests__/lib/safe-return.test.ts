import { describe, it, expect } from 'vitest';
import { isSafeReturnTo } from '@/lib/safe-return';

describe('isSafeReturnTo', () => {
  it('keeps a same-origin path with its query and hash', () => {
    expect(isSafeReturnTo('/dashboard?tab=a#x', '/fallback')).toBe('/dashboard?tab=a#x');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/x'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash host', '/\\evil.example'],
    ['a relative path', 'dashboard'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('falls back for %s', (_label, value) => {
    expect(isSafeReturnTo(value, '/fallback')).toBe('/fallback');
  });

  it('defaults the fallback to /', () => {
    expect(isSafeReturnTo('//evil.example')).toBe('/');
  });

  it('falls back for an excluded path, with or without a query', () => {
    const exclude = ['/accept-terms'];
    expect(isSafeReturnTo('/accept-terms', '/dashboard', exclude)).toBe('/dashboard');
    expect(isSafeReturnTo('/accept-terms?returnTo=%2Fx', '/dashboard', exclude)).toBe('/dashboard');
    expect(isSafeReturnTo('/accept-terms-other', '/dashboard', exclude)).toBe(
      '/accept-terms-other',
    );
  });
});
