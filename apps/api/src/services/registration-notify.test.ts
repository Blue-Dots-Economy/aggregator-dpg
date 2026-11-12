import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMintApprovalToken } = vi.hoisted(() => ({ mockMintApprovalToken: vi.fn() }));

vi.mock('./approval-token.js', () => ({ mintApprovalToken: mockMintApprovalToken }));

vi.mock('../config.js', () => ({ config: { APPROVAL_TOKEN_TTL_SECONDS: 604800 } }));

describe('mintReviewToken', () => {
  beforeEach(() => {
    mockMintApprovalToken.mockReset();
  });

  it('mints a single review token with the configured TTL', async () => {
    mockMintApprovalToken.mockResolvedValueOnce({ token: 'review-tok', expiresAt: new Date() });
    const { mintReviewToken } = await import('./registration-notify.js');
    const token = await mintReviewToken('agg-1');
    expect(token).toBe('review-tok');
    expect(mockMintApprovalToken).toHaveBeenCalledTimes(1);
    expect(mockMintApprovalToken).toHaveBeenNthCalledWith(1, {
      aggregatorId: 'agg-1',
      intent: 'approve',
      ttlSec: 604800,
    });
  });

  it('includes the org claim when provided', async () => {
    mockMintApprovalToken.mockResolvedValueOnce({ token: 'a', expiresAt: new Date() });
    const { mintReviewToken } = await import('./registration-notify.js');
    await mintReviewToken('agg-1', 'org-1');
    expect(mockMintApprovalToken).toHaveBeenNthCalledWith(1, {
      aggregatorId: 'agg-1',
      intent: 'approve',
      ttlSec: 604800,
      org: 'org-1',
    });
  });

  it('throws HttpError TOKEN_MINT_FAILED when minting throws', async () => {
    mockMintApprovalToken.mockRejectedValueOnce(new Error('signing key missing'));
    const { mintReviewToken } = await import('./registration-notify.js');
    await expect(mintReviewToken('agg-1')).rejects.toMatchObject({
      code: 'TOKEN_MINT_FAILED',
    });
  });
});
