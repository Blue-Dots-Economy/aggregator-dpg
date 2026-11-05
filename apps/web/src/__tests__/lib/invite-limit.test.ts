/**
 * Unit tests for resolveMaxInvites: the configured name, the default for
 * unset or invalid values, and that the NEXT_PUBLIC_ name is not read.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_INVITES, resolveMaxInvites } from '@/lib/invite-limit';

describe('resolveMaxInvites', () => {
  it('reads INVITE_MAX_RECIPIENTS', () => {
    expect(resolveMaxInvites({ INVITE_MAX_RECIPIENTS: '25' })).toBe(25);
  });

  it('ignores NEXT_PUBLIC_INVITE_MAX_RECIPIENTS', () => {
    expect(resolveMaxInvites({ NEXT_PUBLIC_INVITE_MAX_RECIPIENTS: '5' })).toBe(DEFAULT_MAX_INVITES);
    expect(
      resolveMaxInvites({ INVITE_MAX_RECIPIENTS: '', NEXT_PUBLIC_INVITE_MAX_RECIPIENTS: '5' }),
    ).toBe(DEFAULT_MAX_INVITES);
  });

  it('uses the default when unset, zero, negative or not a whole number', () => {
    for (const v of [undefined, '0', '-3', '2.5', 'ten']) {
      expect(resolveMaxInvites({ INVITE_MAX_RECIPIENTS: v })).toBe(DEFAULT_MAX_INVITES);
    }
  });
});
