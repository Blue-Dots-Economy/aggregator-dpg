/**
 * Unit tests for resolveMaxInvites and resolveHourlyInvites: the configured name, the legacy
 * NEXT_PUBLIC_ name, and the default for unset or invalid values.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HOURLY_INVITES,
  DEFAULT_MAX_INVITES,
  resolveHourlyInvites,
  resolveMaxInvites,
} from '@/lib/invite-limit';

describe('resolveMaxInvites', () => {
  it('reads INVITE_MAX_RECIPIENTS', () => {
    expect(resolveMaxInvites({ INVITE_MAX_RECIPIENTS: '25' } as NodeJS.ProcessEnv)).toBe(25);
  });

  it('falls back to NEXT_PUBLIC_INVITE_MAX_RECIPIENTS when the first is empty', () => {
    expect(
      resolveMaxInvites({
        INVITE_MAX_RECIPIENTS: '',
        NEXT_PUBLIC_INVITE_MAX_RECIPIENTS: '5',
      } as NodeJS.ProcessEnv),
    ).toBe(5);
  });

  it('uses the default when unset, zero, negative or not a whole number', () => {
    for (const v of [undefined, '0', '-3', '2.5', 'ten']) {
      expect(resolveMaxInvites({ INVITE_MAX_RECIPIENTS: v } as NodeJS.ProcessEnv)).toBe(
        DEFAULT_MAX_INVITES,
      );
    }
  });
});

describe('resolveHourlyInvites', () => {
  it('reads INVITE_MINT_RATE_MAX_PER_WINDOW', () => {
    expect(
      resolveHourlyInvites({ INVITE_MINT_RATE_MAX_PER_WINDOW: '50' } as NodeJS.ProcessEnv),
    ).toBe(50);
  });

  it('uses the default when unset, empty or invalid', () => {
    for (const v of [undefined, '', '0', 'many']) {
      expect(
        resolveHourlyInvites({ INVITE_MINT_RATE_MAX_PER_WINDOW: v } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_HOURLY_INVITES);
    }
  });
});
