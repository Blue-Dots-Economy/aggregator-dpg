/**
 * Unit tests for the shared lazy BullMQ enqueue client.
 *
 * `bullmq` and `@aggregator-dpg/queue`'s `createRedisConnection` are mocked
 * (per testing.md §1 — third-party adapters may be stubbed) so no real Redis
 * connection or queue is created. Covers lazy construction, singleton reuse,
 * the swallowing error handler, and close-then-rebuild.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const addMock = vi.fn();
const closeMock = vi.fn();
const queueCtorCalls: Array<{ name: string; opts: unknown }> = [];

vi.mock('bullmq', () => {
  class MockQueue {
    add = addMock;
    close = closeMock;
    constructor(name: string, opts: unknown) {
      queueCtorCalls.push({ name, opts });
    }
  }
  return { Queue: MockQueue };
});

const onMock = vi.fn();
const quitMock = vi.fn().mockResolvedValue(undefined);
const redisCtorCalls: Array<{ url: string }> = [];

vi.mock('@aggregator-dpg/queue', () => ({
  createRedisConnection: vi.fn((opts: { url: string }) => {
    redisCtorCalls.push({ url: opts.url });
    return { on: onMock, quit: quitMock };
  }),
}));

import { createQueueClient } from './queue-client.js';

function makeClient() {
  return createQueueClient<{ id: string }>({
    name: 'test-queue',
    url: 'redis://test:6379',
    defaultJobOptions: { attempts: 3 },
    operation: 'testQueue',
  });
}

describe('createQueueClient', () => {
  beforeEach(() => {
    addMock.mockReset();
    closeMock.mockReset().mockResolvedValue(undefined);
    onMock.mockReset();
    quitMock.mockClear().mockResolvedValue(undefined);
    queueCtorCalls.length = 0;
    redisCtorCalls.length = 0;
  });

  it('builds nothing until queue() is called', () => {
    makeClient();
    expect(redisCtorCalls).toHaveLength(0);
    expect(queueCtorCalls).toHaveLength(0);
  });

  it('builds the connection + queue once and reuses both', () => {
    const client = makeClient();
    const first = client.queue();
    const second = client.queue();
    expect(first).toBe(second);
    expect(redisCtorCalls).toEqual([{ url: 'redis://test:6379' }]);
    expect(queueCtorCalls).toHaveLength(1);
    expect(queueCtorCalls[0]?.name).toBe('test-queue');
    expect(queueCtorCalls[0]?.opts).toMatchObject({ defaultJobOptions: { attempts: 3 } });
  });

  it('registers a redis error handler that logs without throwing', () => {
    makeClient().queue();
    const handler = onMock.mock.calls.find((c) => c[0] === 'error')?.[1] as (e: Error) => void;
    expect(handler).toBeTypeOf('function');
    expect(() => handler(new Error('conn reset'))).not.toThrow();
  });

  it('close() shuts both down and lets queue() rebuild', async () => {
    const client = makeClient();
    client.queue();
    await client.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(quitMock).toHaveBeenCalledTimes(1);

    client.queue();
    expect(redisCtorCalls).toHaveLength(2);
    expect(queueCtorCalls).toHaveLength(2);
  });

  it('close() is a no-op when nothing was built, and tolerates a quit() rejection', async () => {
    const never = makeClient();
    await expect(never.close()).resolves.toBeUndefined();
    expect(closeMock).not.toHaveBeenCalled();

    quitMock.mockRejectedValueOnce(new Error('already closed'));
    const built = makeClient();
    built.queue();
    await expect(built.close()).resolves.toBeUndefined();
  });
});
