import { describe, it, expect, vi } from 'vitest';
import {
  DASHBOARD_MAX_LIMIT,
  MAX_SELECT_ALL_PAGES,
  readAllMatching,
} from '@/app/(protected)/dashboard/_lib/select-all';

/** A reader over `total` items that serves any page and limit. */
function reader(total: number) {
  return vi.fn(async (page: number, limit: number) => {
    const start = (page - 1) * limit;
    const count = Math.max(0, Math.min(limit, total - start));
    return Array.from({ length: count }, (_, i) => ({ n: start + i }));
  });
}

describe('readAllMatching', () => {
  it('reads a small set in one call sized to the total', async () => {
    const read = reader(5);
    const result = await readAllMatching(read, 5);
    expect(result.items).toHaveLength(5);
    expect(result.complete).toBe(true);
    expect(read.mock.calls).toEqual([[1, 5]]);
  });

  it('reads exactly one full page at the limit', async () => {
    const read = reader(DASHBOARD_MAX_LIMIT);
    const result = await readAllMatching(read, DASHBOARD_MAX_LIMIT);
    expect(result).toMatchObject({ complete: true });
    expect(read.mock.calls).toEqual([[1, DASHBOARD_MAX_LIMIT]]);
  });

  it('pages through a set larger than the limit, in order', async () => {
    const read = reader(401);
    const result = await readAllMatching(read, 401);
    expect(result.items.map((r) => r.n)).toEqual(Array.from({ length: 401 }, (_, i) => i));
    expect(result.complete).toBe(true);
    expect(read.mock.calls).toEqual([
      [1, DASHBOARD_MAX_LIMIT],
      [2, DASHBOARD_MAX_LIMIT],
      [3, DASHBOARD_MAX_LIMIT],
    ]);
  });

  it('stops at a short page and reports the read as incomplete', async () => {
    const read = reader(250);
    const result = await readAllMatching(read, 1000);
    expect(result.items).toHaveLength(250);
    expect(result.complete).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads at most MAX_SELECT_ALL_PAGES pages and reports the read as incomplete', async () => {
    const total = (MAX_SELECT_ALL_PAGES + 2) * DASHBOARD_MAX_LIMIT;
    const read = reader(total);
    const result = await readAllMatching(read, total);
    expect(read).toHaveBeenCalledTimes(MAX_SELECT_ALL_PAGES);
    expect(result.items).toHaveLength(MAX_SELECT_ALL_PAGES * DASHBOARD_MAX_LIMIT);
    expect(result.complete).toBe(false);
  });

  it('makes no call when nothing matches', async () => {
    const read = reader(0);
    expect(await readAllMatching(read, 0)).toEqual({ items: [], complete: true });
    expect(read).not.toHaveBeenCalled();
  });

  it('stops reading pages once the signal is aborted', async () => {
    const controller = new AbortController();
    const read = vi.fn(async (page: number, limit: number) => {
      if (page === 1) controller.abort();
      return Array.from({ length: limit }, (_, i) => ({ n: i }));
    });
    await expect(readAllMatching(read, 600, controller.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('passes a failed read on to the caller', async () => {
    const read = vi.fn(async () => {
      throw new Error('upstream down');
    });
    await expect(readAllMatching(read, 10)).rejects.toThrow('upstream down');
  });
});
