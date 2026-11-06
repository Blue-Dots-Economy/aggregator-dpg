import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  avatarInitials,
  failureText,
  fmtCount,
  formatRelative,
} from '@/app/(protected)/dashboard/_lib/format';
import { ResponseShapeError } from '@/lib/response-shape-error';

describe('fmtCount', () => {
  it('shows an em dash for a missing value', () => {
    expect(fmtCount(undefined)).toBe('—');
    expect(fmtCount(null)).toBe('—');
  });

  it('formats zero and rounds to two decimals', () => {
    expect(fmtCount(0)).toBe('0');
    expect(fmtCount(1.16666)).toBe((1.17).toLocaleString());
  });
});

describe('formatRelative', () => {
  const now = new Date('2024-06-01T12:00:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;

  it('describes each range', () => {
    expect(formatRelative(ago(30_000))).toBe('just now');
    expect(formatRelative(ago(5 * MIN))).toBe('5m ago');
    expect(formatRelative(ago(3 * 60 * MIN))).toBe('3h ago');
    expect(formatRelative(ago(2 * 24 * 60 * MIN))).toBe('2d ago');
    expect(formatRelative(ago(65 * 24 * 60 * MIN))).toBe('2mo ago');
  });

  it('shows an em dash for an invalid date', () => {
    expect(formatRelative('not a date')).toBe('—');
  });
});

describe('avatarInitials', () => {
  it('uses the first and last words', () => {
    expect(avatarInitials('ada byron lovelace')).toBe('AL');
  });

  it('uses the first two letters of a single word', () => {
    expect(avatarInitials('  zed ')).toBe('ZE');
  });

  it('returns ?? without a name', () => {
    expect(avatarInitials('')).toBe('??');
    expect(avatarInitials('—')).toBe('??');
  });
});

describe('failureText', () => {
  it('hides the raw text of an unreadable reply', () => {
    expect(failureText(new ResponseShapeError('/x', []), 'unreadable', 'fallback')).toBe(
      'unreadable',
    );
  });

  it("uses an Error's message, else the fallback", () => {
    expect(failureText(new Error('boom'), 'unreadable', 'fallback')).toBe('boom');
    expect(failureText('nope', 'unreadable', 'fallback')).toBe('fallback');
  });
});
