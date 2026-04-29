import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisSessionStore } from '@/lib/session/redis';
import { buildSessionData } from '@/lib/session/testing';

interface FakeRedis {
  store: Map<string, string>;
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function makeFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, _mode?: string, _ttl?: number) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
  };
}

describe('RedisSessionStore', () => {
  let fake: FakeRedis;
  let s: RedisSessionStore;

  beforeEach(() => {
    fake = makeFakeRedis();
    s = new RedisSessionStore({
      ttlSec: 30,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fake as any,
    });
  });

  it('creates session with TTL', async () => {
    const sid = await s.create(buildSessionData());
    expect(typeof sid).toBe('string');
    expect(fake.set).toHaveBeenCalledWith(`session:${sid}`, expect.any(String), 'EX', 30);
  });

  it('reads back created session', async () => {
    const sid = await s.create(buildSessionData({ sub: 'kc-user-1' }));
    const got = await s.get(sid);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.sub).toBe('kc-user-1');
  });

  it('slides TTL on read', async () => {
    const sid = await s.create(buildSessionData());
    await s.get(sid);
    expect(fake.expire).toHaveBeenCalledWith(`session:${sid}`, 30);
  });

  it('returns NOT_FOUND for empty sid', async () => {
    const got = await s.get('');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when key absent', async () => {
    const got = await s.get('missing-id');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('NOT_FOUND');
  });

  it('returns CORRUPT on unparseable payload', async () => {
    fake.store.set('session:bad', '{not-json');
    const got = await s.get('bad');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('CORRUPT');
  });

  it('returns STORE_UNAVAILABLE on Redis failure', async () => {
    fake.get.mockRejectedValueOnce(new Error('connection refused'));
    const got = await s.get('any');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('STORE_UNAVAILABLE');
  });

  it('updates patch and re-saves', async () => {
    const sid = await s.create(buildSessionData({ name: 'Old' }));
    const upd = await s.update(sid, { name: 'New' });
    expect(upd.ok).toBe(true);
    const got = await s.get(sid);
    if (got.ok) expect(got.value.name).toBe('New');
  });

  it('destroy removes the key', async () => {
    const sid = await s.create(buildSessionData());
    await s.destroy(sid);
    const got = await s.get(sid);
    expect(got.ok).toBe(false);
  });

  it('destroy of empty sid is no-op', async () => {
    await expect(s.destroy('')).resolves.toBeUndefined();
    expect(fake.del).not.toHaveBeenCalled();
  });
});
