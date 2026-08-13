/**
 * Unit tests for the Lua script loader + EVALSHA executor.
 *
 * `redis` is a hand-built stub exposing only `evalsha`/`eval` (the subset
 * `runBulkRowCommit` calls) rather than a real ioredis client — no network
 * access, per testing.md §6.
 *
 * @module @aggregator-dpg/queue
 */
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { runBulkRowCommit, bulkRowCommitScript } from '../lua-loader.js';

function makeRedisStub(overrides: Partial<Record<'evalsha' | 'eval', unknown>> = {}) {
  return {
    evalsha: vi.fn(),
    eval: vi.fn(),
    ...overrides,
  } as unknown as Redis & { evalsha: ReturnType<typeof vi.fn>; eval: ReturnType<typeof vi.fn> };
}

describe('bulkRowCommitScript', () => {
  it('loads the Lua source from disk with a non-empty sha1', () => {
    expect(bulkRowCommitScript.source.length).toBeGreaterThan(0);
    expect(bulkRowCommitScript.sha1).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('runBulkRowCommit', () => {
  it('calls EVALSHA with the six namespaced keys and stringified args, mapping the reply', async () => {
    const redis = makeRedisStub();
    (redis.evalsha as ReturnType<typeof vi.fn>).mockResolvedValue([5, 10, 1, 1]);

    const result = await runBulkRowCommit(redis, 'up-1', 3, 'passed', '', 60);

    expect(redis.evalsha).toHaveBeenCalledWith(
      bulkRowCommitScript.sha1,
      5,
      'bu:up-1:processed',
      'bu:up-1:counters',
      'bu:up-1:errors',
      'bu:up-1:error_rows',
      'bu:up-1:meta',
      '3',
      'passed',
      '',
      '60',
    );
    expect(result).toEqual({ processed: 5, total: 10, readerDone: 1, wasNew: 1 });
  });

  it('coerces non-1 readerDone/wasNew flags to 0', async () => {
    const redis = makeRedisStub();
    (redis.evalsha as ReturnType<typeof vi.fn>).mockResolvedValue([2, -1, 0, 0]);

    const result = await runBulkRowCommit(redis, 'up-2', 0, 'skipped', '', 0);

    expect(result).toEqual({ processed: 2, total: -1, readerDone: 0, wasNew: 0 });
  });

  it('falls back to EVAL when EVALSHA rejects with NOSCRIPT', async () => {
    const redis = makeRedisStub();
    (redis.evalsha as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('NOSCRIPT No matching script'),
    );
    (redis.eval as ReturnType<typeof vi.fn>).mockResolvedValue([1, 1, 0, 1]);

    const result = await runBulkRowCommit(redis, 'up-3', 1, 'failed', '{"e":1}', 60);

    expect(redis.eval).toHaveBeenCalledWith(
      bulkRowCommitScript.source,
      5,
      'bu:up-3:processed',
      'bu:up-3:counters',
      'bu:up-3:errors',
      'bu:up-3:error_rows',
      'bu:up-3:meta',
      '1',
      'failed',
      '{"e":1}',
      '60',
    );
    expect(result).toEqual({ processed: 1, total: 1, readerDone: 0, wasNew: 1 });
  });

  it('rethrows a non-NOSCRIPT error from EVALSHA without falling back to EVAL', async () => {
    const redis = makeRedisStub();
    (redis.evalsha as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection reset'));

    await expect(runBulkRowCommit(redis, 'up-4', 0, 'passed', '', 60)).rejects.toThrow(
      'connection reset',
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('throws a descriptive error when the script returns an unexpected shape', async () => {
    const redis = makeRedisStub();
    (redis.evalsha as ReturnType<typeof vi.fn>).mockResolvedValue([1, 2, 3]);

    await expect(runBulkRowCommit(redis, 'up-5', 0, 'passed', '', 60)).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
