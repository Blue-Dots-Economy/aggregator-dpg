import { describe, expect, it, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { IdempotencyStore } from '../idempotency.js';

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;
  beforeEach(() => {
    store = new IdempotencyStore(new RedisMock() as never, 90);
  });

  it('returns "first" on first sighting and "duplicate" after', async () => {
    expect(await store.see('k-1')).toBe('first');
    expect(await store.see('k-1')).toBe('duplicate');
  });

  it('returns "unavailable" when redis throws', async () => {
    const broken = {
      set: async () => {
        throw new Error('down');
      },
    } as never;
    const s = new IdempotencyStore(broken, 90);
    expect(await s.see('k')).toBe('unavailable');
  });
});
