import { describe, it, expect, beforeEach } from 'vitest';
import { mintApprovalToken, verifyApprovalToken, _resetTokenKey } from './approval-token.js';

describe('approval-token', () => {
  beforeEach(() => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
  });

  it('round-trips approve intent', async () => {
    const m = await mintApprovalToken({
      aggregatorId: '11111111-1111-1111-1111-111111111111',
      intent: 'approve',
    });
    const v = await verifyApprovalToken(m.token);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.aggregatorId).toBe('11111111-1111-1111-1111-111111111111');
      expect(v.intent).toBe('approve');
    }
  });

  it('round-trips reject intent', async () => {
    const m = await mintApprovalToken({
      aggregatorId: '22222222-2222-2222-2222-222222222222',
      intent: 'reject',
    });
    const v = await verifyApprovalToken(m.token);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.intent).toBe('reject');
  });

  it('rejects tampered token (signature)', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: '33333333-3333-3333-3333-333333333333',
      intent: 'approve',
    });
    const tampered = `${token.slice(0, -2)}xx`;
    const v = await verifyApprovalToken(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(['INVALID', 'MALFORMED']).toContain(v.error.code);
  });

  it('rejects malformed token', async () => {
    const v = await verifyApprovalToken('not-a-jwt');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('MALFORMED');
  });

  it('rejects token signed with different secret', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: '44444444-4444-4444-4444-444444444444',
      intent: 'approve',
    });
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'z'.repeat(48);
    const v = await verifyApprovalToken(token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('INVALID');
  });

  it('rejects expired token', async () => {
    const { token } = await mintApprovalToken({
      aggregatorId: '55555555-5555-5555-5555-555555555555',
      intent: 'approve',
      ttlSec: -10,
    });
    const v = await verifyApprovalToken(token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe('EXPIRED');
  });

  it('mint records expiry ~1h ahead by default', async () => {
    const before = Date.now();
    const m = await mintApprovalToken({
      aggregatorId: '66666666-6666-6666-6666-666666666666',
      intent: 'approve',
    });
    const oneHour = 60 * 60 * 1000;
    expect(m.expiresAt.getTime() - before).toBeGreaterThanOrEqual(oneHour - 1000);
    expect(m.expiresAt.getTime() - before).toBeLessThan(oneHour + 1000);
  });

  it('throws if secret missing', () => {
    _resetTokenKey();
    delete process.env.APPROVAL_TOKEN_SECRET;
    return expect(
      mintApprovalToken({
        aggregatorId: 'x',
        intent: 'approve',
      }),
    ).rejects.toThrow(/APPROVAL_TOKEN_SECRET/);
  });
});
