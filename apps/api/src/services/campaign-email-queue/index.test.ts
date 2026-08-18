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
  QueueName: { CampaignEmail: 'campaign-email' },
  EMAIL_JOB_OPTS: { attempts: 1 },
  createRedisConnection: vi.fn(() => ({ on: vi.fn(), quit: quitMock })),
}));
vi.mock('../../config.js', () => ({ config: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: errorMock } }));

import {
  enqueueCampaignEmail,
  closeCampaignEmailQueue,
  _resetCampaignEmailQueue,
} from './index.js';

const PAYLOAD = {
  orgId: 'org-1',
  itemIds: ['a', 'b'],
  subject: 'Hi {{name}}',
  bodyMarkdown: 'Body',
  replyTo: 'r@x.com',
  purpose: 'audit',
  requestId: 'req-1',
};

describe('enqueueCampaignEmail', () => {
  beforeEach(() => {
    addMock.mockReset().mockResolvedValue(undefined);
    errorMock.mockReset();
  });
  afterEach(async () => {
    await _resetCampaignEmailQueue();
  });

  it('adds a campaign-email job carrying the full payload', async () => {
    await enqueueCampaignEmail(PAYLOAD);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0]![0]).toBe('campaign-email');
    expect(addMock.mock.calls[0]![1]).toEqual(PAYLOAD);
  });

  it('throws (so the route can 503) when the enqueue fails', async () => {
    addMock.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(enqueueCampaignEmail(PAYLOAD)).rejects.toThrow('redis unavailable');
    expect(errorMock).toHaveBeenCalled();
  });

  it('closeCampaignEmailQueue closes the queue and connection (idempotent)', async () => {
    await enqueueCampaignEmail(PAYLOAD);
    await closeCampaignEmailQueue();
    expect(closeMock).toHaveBeenCalled();
    expect(quitMock).toHaveBeenCalled();
    await expect(closeCampaignEmailQueue()).resolves.toBeUndefined();
  });
});
