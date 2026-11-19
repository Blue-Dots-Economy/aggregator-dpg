import { describe, it, expect } from 'vitest';
import { safeReturnPath } from '@/lib/return-to';

describe('safeReturnPath', () => {
  it('keeps a same-origin path with its query and hash', () => {
    expect(safeReturnPath('/dashboard?tab=a#x', '/fallback')).toBe('/dashboard?tab=a#x');
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
    expect(safeReturnPath(value, '/fallback')).toBe('/fallback');
  });

  it('falls back for an excluded path, with or without a query', () => {
    const exclude = ['/accept-terms'];
    expect(safeReturnPath('/accept-terms', '/dashboard', exclude)).toBe('/dashboard');
    expect(safeReturnPath('/accept-terms?returnTo=%2Fx', '/dashboard', exclude)).toBe('/dashboard');
    expect(safeReturnPath('/accept-terms-other', '/dashboard', exclude)).toBe(
      '/accept-terms-other',
    );
  });
});
