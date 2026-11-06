import { describe, it, expect, vi } from 'vitest';
import { DASHBOARD_MAX_LIMIT, readAllMatching } from '@/app/(protected)/dashboard/_lib/select-all';

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
    const rows = await readAllMatching(read, 5);
    expect(rows).toHaveLength(5);
    expect(read.mock.calls).toEqual([[1, 5]]);
  });

  it('reads exactly one full page at the limit', async () => {
    const read = reader(DASHBOARD_MAX_LIMIT);
    expect(await readAllMatching(read, DASHBOARD_MAX_LIMIT)).toHaveLength(DASHBOARD_MAX_LIMIT);
    expect(read.mock.calls).toEqual([[1, DASHBOARD_MAX_LIMIT]]);
  });

  it('pages through a set larger than the limit, in order', async () => {
    const read = reader(401);
    const rows = await readAllMatching(read, 401);
    expect(rows.map((r) => r.n)).toEqual(Array.from({ length: 401 }, (_, i) => i));
    expect(read.mock.calls).toEqual([
      [1, DASHBOARD_MAX_LIMIT],
      [2, DASHBOARD_MAX_LIMIT],
      [3, DASHBOARD_MAX_LIMIT],
    ]);
  });

  it('stops early when a page comes back short', async () => {
    const read = reader(250);
    const rows = await readAllMatching(read, 1000);
    expect(rows).toHaveLength(250);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('makes no call when nothing matches', async () => {
    const read = reader(0);
    expect(await readAllMatching(read, 0)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('passes a failed read on to the caller', async () => {
    const read = vi.fn(async () => {
      throw new Error('upstream down');
    });
    await expect(readAllMatching(read, 10)).rejects.toThrow('upstream down');
  });
});
