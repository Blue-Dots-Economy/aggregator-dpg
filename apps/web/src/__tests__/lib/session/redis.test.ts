import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisSessionStore } from '@/lib/session/redis';
import { buildSessionData } from '@/lib/session/testing';
import { logger } from '@/lib/logger';

interface FakeRedis {
  store: Map<string, string>;
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  getdel: ReturnType<typeof vi.fn>;
  sadd: ReturnType<typeof vi.fn>;
  smembers: ReturnType<typeof vi.fn>;
  sets: Map<string, Set<string>>;
}

function makeFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, _mode?: string, _ttl?: number) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key) || sets.delete(key)) removed += 1;
      }
      return removed;
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    sets,
    sadd: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
      return 1;
    }),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
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

  it('returns CORRUPT when a stored session lacks its tokens', async () => {
    const { accessToken: _missing, ...partial } = buildSessionData();
    fake.store.set('session:sid-partial', JSON.stringify(partial));
    const got = await s.get('sid-partial');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('CORRUPT');
  });

  it('deletes an unreadable session and logs the code without the session id', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    fake.store.set('session:sid-secret-1', '{not-json');
    const got = await s.get('sid-secret-1');
    expect(got.ok).toBe(false);
    expect(fake.del).toHaveBeenCalledWith('session:sid-secret-1');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'session.get', status: 'failure', code: 'CORRUPT' }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sid-secret-1');
    warn.mockRestore();
  });

  it('drops a malformed console actor cache but keeps the session', async () => {
    const session = {
      ...buildSessionData({ sub: 'kc-user-2' }),
      consoleActor: { me: 'stale', at: 'x' },
    };
    fake.store.set('session:sid-actor', JSON.stringify(session));
    const got = await s.get('sid-actor');
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.sub).toBe('kc-user-2');
      expect(got.value.consoleActor).toBeUndefined();
    }
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

  it('remembers a sign-in and its browser under a hash of its state, with the given TTL', async () => {
    await s.rememberSignIn('the-state', 'the-browser', 300);
    const [key, value, mode, ttl] = fake.set.mock.calls[0] ?? [];
    expect(key).toMatch(/^signin:[0-9a-f]{64}$/);
    expect(key).not.toContain('the-state');
    expect([value, mode, ttl]).toEqual(['the-browser', 'EX', 300]);
  });

  it('takes a remembered sign-in once, returning the browser that started it', async () => {
    await s.rememberSignIn('the-state', 'the-browser', 300);
    expect(await s.takeSignIn('the-state')).toBe('the-browser');
    expect(await s.takeSignIn('the-state')).toBeNull();
  });

  it('treats a Redis failure as no sign-in, and never throws on remember', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    fake.set.mockRejectedValueOnce(new Error('down'));
    fake.getdel.mockRejectedValueOnce(new Error('down'));
    await expect(s.rememberSignIn('the-state', 'the-browser', 300)).resolves.toBeUndefined();
    expect(await s.takeSignIn('the-state')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('lists a session under its hashed IdP session id, with the session TTL', async () => {
    const sid = await s.create(buildSessionData({ idpSid: 'kc-1' }));
    const [index, member] = fake.sadd.mock.calls[0] ?? [];
    expect(index).toMatch(/^sessionidp:[0-9a-f]{64}$/);
    expect(member).toBe(sid);
    expect(fake.expire).toHaveBeenCalledWith(index, 30);
  });

  it('slides the IdP index with the session on read', async () => {
    const sid = await s.create(buildSessionData({ idpSid: 'kc-1' }));
    const [index] = fake.sadd.mock.calls[0] ?? [];
    fake.expire.mockClear();
    await s.get(sid);
    expect(fake.expire).toHaveBeenCalledWith(`session:${sid}`, 30);
    expect(fake.expire).toHaveBeenCalledWith(index, 30);
  });

  it('destroys every session under an IdP session, and only those', async () => {
    const a = await s.create(buildSessionData({ idpSid: 'kc-1' }));
    const b = await s.create(buildSessionData({ idpSid: 'kc-1' }));
    const other = await s.create(buildSessionData({ idpSid: 'kc-2' }));

    expect(await s.destroyByIdpSession('kc-1')).toBe(2);

    expect((await s.get(a)).ok).toBe(false);
    expect((await s.get(b)).ok).toBe(false);
    expect((await s.get(other)).ok).toBe(true);
  });

  it('does not index a session without an IdP session id', async () => {
    await s.create(buildSessionData());
    expect(fake.sadd).not.toHaveBeenCalled();
  });
});
