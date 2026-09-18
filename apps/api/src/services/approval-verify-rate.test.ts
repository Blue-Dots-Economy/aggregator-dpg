import { describe, it, expect, vi, beforeEach } from 'vitest';

const { consumeSlotMock } = vi.hoisted(() => ({
  consumeSlotMock: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock('./rate-limiter/index.js', () => ({ consumeSlot: consumeSlotMock }));

import {
  checkApprovalVerifyRate,
  _setApprovalVerifyRateChecker,
  APPROVAL_VERIFY_RATE_WINDOW_SECONDS,
  APPROVAL_VERIFY_RATE_MAX_PER_WINDOW,
} from './approval-verify-rate.js';

describe('checkApprovalVerifyRate', () => {
  beforeEach(() => {
    consumeSlotMock.mockClear();
    consumeSlotMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    _setApprovalVerifyRateChecker(null);
  });

  it('consumes one fail-closed slot from the approval-verify bucket keyed by the given key', async () => {
    const res = await checkApprovalVerifyRate('203.0.113.7');

    expect(res).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(consumeSlotMock).toHaveBeenCalledTimes(1);
    expect(consumeSlotMock).toHaveBeenCalledWith({
      namespace: 'approval-verify',
      key: '203.0.113.7',
      windowSeconds: APPROVAL_VERIFY_RATE_WINDOW_SECONDS,
      max: APPROVAL_VERIFY_RATE_MAX_PER_WINDOW,
      failClosed: true,
    });
  });

  it('surfaces a denial with its retry-after when the window cap is exceeded', async () => {
    consumeSlotMock.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 17,
    });

    const res = await checkApprovalVerifyRate('203.0.113.7');

    expect(res).toEqual({ allowed: false, retryAfterSeconds: 17 });
  });

  it('uses an injected checker override instead of the real limiter, then restores it', async () => {
    _setApprovalVerifyRateChecker(async () => ({
      allowed: false,
      retryAfterSeconds: 5,
    }));

    const overridden = await checkApprovalVerifyRate('anything');
    expect(overridden).toEqual({ allowed: false, retryAfterSeconds: 5 });
    expect(consumeSlotMock).not.toHaveBeenCalled();

    _setApprovalVerifyRateChecker(null);
    const restored = await checkApprovalVerifyRate('anything');
    expect(restored.allowed).toBe(true);
    expect(consumeSlotMock).toHaveBeenCalledTimes(1);
  });
});
