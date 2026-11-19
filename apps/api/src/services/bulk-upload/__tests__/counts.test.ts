/**
 * Live counters of a bulk upload read from Redis.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { logger } from '../../../logger.js';
import { _setRedis } from '../../redis/index.js';
import { loadCounts, ZERO_COUNTS } from '../counts.js';

/** A Redis stand-in exposing only the two reads the counters use. */
function redisWith(hmget: Redis['hmget'], hget: Redis['hget']): Redis {
  return Object.assign(Object.create(null), { hmget, hget });
}

afterEach(() => {
  _setRedis(null);
  vi.restoreAllMocks();
});

describe('loadCounts for an upload in flight', () => {
  it('reads the counters and the row total', async () => {
    _setRedis(
      redisWith(vi.fn().mockResolvedValue(['3', '1', '0']), vi.fn().mockResolvedValue('5')),
    );
    expect(await loadCounts('up-1', 'row_processing')).toEqual({
      totalRows: 5,
      passed: 3,
      failed: 1,
      skipped: 0,
    });
  });

  it('logs a warning and answers zero counts when Redis fails', async () => {
    const warn = vi.spyOn(logger, 'warn');
    _setRedis(redisWith(vi.fn().mockRejectedValue(new TypeError('redis down')), vi.fn()));
    expect(await loadCounts('up-1', 'row_processing')).toEqual(ZERO_COUNTS);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'bulkUpload.loadCountsFromRedis',
        status: 'failure',
        error: 'redis down',
        error_type: 'TypeError',
        upload_id: 'up-1',
      }),
    );
  });
});
