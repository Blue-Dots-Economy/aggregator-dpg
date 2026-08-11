import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// No real Redis/BullMQ: mock the queue surface + connection so we assert the
// enqueue shape and the throw-on-failure contract.
const { addMock, closeMock, quitMock, errorMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  closeMock: vi.fn(() => Promise.resolve()),
  quitMock: vi.fn(() => Promise.resolve()),
  errorMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: addMock, close: closeMock })),
}));
vi.mock('@aggregator-dpg/queue', () => ({
  QueueName: { CampaignExport: 'campaign-export' },
  DEFAULT_JOB_OPTS: { attempts: 3 },
  createRedisConnection: vi.fn(() => ({ on: vi.fn(), quit: quitMock })),
}));
vi.mock('../../config.js', () => ({ config: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: errorMock } }));

import {
  enqueueCampaignExport,
  closeCampaignExportQueue,
  _resetCampaignExportQueue,
} from './index.js';

describe('enqueueCampaignExport', () => {
  beforeEach(() => {
    addMock.mockReset().mockResolvedValue(undefined);
    errorMock.mockReset();
  });
  afterEach(async () => {
    await _resetCampaignExportQueue();
  });

  it('adds a campaign-export job carrying the full payload', async () => {
    await enqueueCampaignExport({
      orgId: 'org-1',
      itemIds: ['a', 'b'],
      recipientEmail: 'agg@org.example',
      purpose: 'audit',
      requestId: 'req-1',
    });
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0]![0]).toBe('campaign-export');
    expect(addMock.mock.calls[0]![1]).toEqual({
      orgId: 'org-1',
      itemIds: ['a', 'b'],
      recipientEmail: 'agg@org.example',
      purpose: 'audit',
      requestId: 'req-1',
    });
  });

  it('throws (so the route can 503) when the enqueue fails', async () => {
    addMock.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(
      enqueueCampaignExport({ orgId: 'org-1', itemIds: ['a'], recipientEmail: 'agg@org.example' }),
    ).rejects.toThrow('redis unavailable');
    expect(errorMock).toHaveBeenCalled();
  });

  it('closeCampaignExportQueue closes the queue and connection (idempotent)', async () => {
    await enqueueCampaignExport({
      orgId: 'org-1',
      itemIds: ['a'],
      recipientEmail: 'agg@org.example',
    });
    await closeCampaignExportQueue();
    expect(closeMock).toHaveBeenCalled();
    expect(quitMock).toHaveBeenCalled();
    // second close is a no-op (singletons cleared)
    await expect(closeCampaignExportQueue()).resolves.toBeUndefined();
  });
});
