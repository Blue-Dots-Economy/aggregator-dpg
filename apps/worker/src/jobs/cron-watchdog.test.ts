/**
 * Unit tests for the stuck-job watchdog + retention sweeper cron job.
 *
 * `runWatchdog` is a queue-consumer job that reads/writes Postgres (via a
 * hand-built chainable Drizzle stub) and purges Redis working-set keys. Both
 * are faked here. DB calls happen in a fixed, sequential order in the source
 * (`update bulkUploads` abandoned -> `update bulkUploads` stuck -> `delete
 * bulkUploads` retention -> `delete linkSubmissions` retention), so the fake
 * dispenses one canned result per call in that order.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── DB fake — one queue of results per call-site, consumed in source order ──

let updateReturns: Array<Array<{ id: string }>> = [[], []];
let deleteReturns: Array<Array<{ id: string }>> = [[], []];
let updateShouldThrow: Error | null = null;
let updateCallIdx = 0;
let deleteCallIdx = 0;
const updateSets: Array<Record<string, unknown>> = [];

function makeDb() {
  return {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateSets.push(v);
        return {
          where: () => ({
            returning: async () => {
              if (updateShouldThrow) throw updateShouldThrow;
              return updateReturns[updateCallIdx++] ?? [];
            },
          }),
        };
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => deleteReturns[deleteCallIdx++] ?? [],
      }),
    }),
  };
}

vi.mock('../db.js', () => ({
  getDb: () => makeDb(),
  schema: {
    bulkUploads: {
      id: 'id',
      status: 'status',
      createdAt: 'createdAt',
      lastProgressAt: 'lastProgressAt',
    },
    linkSubmissions: { id: 'id', rolledUpAt: 'rolledUpAt', createdAt: 'createdAt' },
  },
}));

// ─── Redis fake ──────────────────────────────────────────────────────────────

const del = vi.fn(async (...keys: string[]) => keys.length);
vi.mock('../services/redis.js', () => ({ getRedis: () => ({ del }) }));

vi.mock('../config.js', () => ({
  config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { runWatchdog } = await import('./cron-watchdog.js');

beforeEach(() => {
  vi.clearAllMocks();
  updateReturns = [[], []];
  deleteReturns = [[], []];
  updateShouldThrow = null;
  updateCallIdx = 0;
  deleteCallIdx = 0;
  updateSets.length = 0;
});

describe('runWatchdog — normal execution', () => {
  it('reports abandoned + stuck uploads and purges their Redis working set', async () => {
    updateReturns = [[{ id: 'b1' }, { id: 'b2' }], [{ id: 's1' }]];
    deleteReturns = [[{ id: 'p1' }], [{ id: 'sub1' }, { id: 'sub2' }]];

    const res = await runWatchdog();

    expect(res).toEqual({ abandoned: 2, stuck: 1, bulkPurged: 1, submissionsPurged: 2 });
    expect(updateSets[0]).toMatchObject({ status: 'failed', statusReason: 'upload_abandoned' });
    expect(updateSets[1]).toMatchObject({ status: 'failed', statusReason: 'processing_stuck' });
    expect(del).toHaveBeenCalledTimes(1);
    const keys = del.mock.calls[0]!;
    // 3 terminal ids (b1, b2, s1) x 6 keys per upload namespace = 18.
    expect(keys).toHaveLength(18);
    expect(keys).toEqual(expect.arrayContaining(['bu:b1:lines', 'bu:s1:errors']));
  });

  it('does not touch Redis when there are no newly-terminal uploads', async () => {
    updateReturns = [[], []];
    deleteReturns = [[{ id: 'p1' }], []];

    const res = await runWatchdog();

    expect(res).toEqual({ abandoned: 0, stuck: 0, bulkPurged: 1, submissionsPurged: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it('purges Redis keys for abandoned-only uploads (stuck pass empty)', async () => {
    updateReturns = [[{ id: 'b1' }], []];
    deleteReturns = [[], []];

    const res = await runWatchdog();

    expect(res.abandoned).toBe(1);
    expect(res.stuck).toBe(0);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]).toHaveLength(6);
  });

  it('runs the retention sweep independently of the watchdog pass', async () => {
    updateReturns = [[], []];
    deleteReturns = [[{ id: 'old-1' }, { id: 'old-2' }], [{ id: 'old-sub' }]];

    const res = await runWatchdog();

    expect(res).toEqual({ abandoned: 0, stuck: 0, bulkPurged: 2, submissionsPurged: 1 });
  });

  it('returns all-zero counts on a fully quiet run', async () => {
    const res = await runWatchdog();
    expect(res).toEqual({ abandoned: 0, stuck: 0, bulkPurged: 0, submissionsPurged: 0 });
    expect(del).not.toHaveBeenCalled();
  });
});

describe('runWatchdog — failure propagation', () => {
  it('propagates a DB failure rather than swallowing it', async () => {
    updateShouldThrow = new Error('connection terminated unexpectedly');
    await expect(runWatchdog()).rejects.toThrow('connection terminated unexpectedly');
  });
});
