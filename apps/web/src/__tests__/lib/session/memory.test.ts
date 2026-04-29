import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySessionStore } from '@/lib/session/memory';
import { SessionStoreFake, buildSessionData } from '@/lib/session/testing';

describe('MemorySessionStore', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore({ ttlSec: 1 });
  });

  it('creates and retrieves a session', async () => {
    const data = buildSessionData();
    const sid = await store.create(data);
    const got = await store.get(sid);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.sub).toBe(data.sub);
  });

  it('returns NOT_FOUND for empty sid', async () => {
    const got = await store.get('');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND for unknown sid', async () => {
    const got = await store.get('does-not-exist');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('NOT_FOUND');
  });

  it('expires sessions after TTL elapses', async () => {
    const sid = await store.create(buildSessionData());
    await new Promise((r) => setTimeout(r, 1100));
    const got = await store.get(sid);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('NOT_FOUND');
  });

  it('updates merge fields and slides TTL', async () => {
    const sid = await store.create(buildSessionData({ name: 'Old' }));
    const upd = await store.update(sid, { name: 'New' });
    expect(upd.ok).toBe(true);
    const got = await store.get(sid);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.name).toBe('New');
  });

  it('update returns NOT_FOUND if session is gone', async () => {
    const upd = await store.update('missing', { name: 'X' });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.code).toBe('NOT_FOUND');
  });

  it('destroy is idempotent', async () => {
    const sid = await store.create(buildSessionData());
    await store.destroy(sid);
    await expect(store.destroy(sid)).resolves.toBeUndefined();
    const got = await store.get(sid);
    expect(got.ok).toBe(false);
  });

  it('close clears all sessions', async () => {
    const sid = await store.create(buildSessionData());
    await store.close();
    const got = await store.get(sid);
    expect(got.ok).toBe(false);
  });
});

describe('SessionStoreFake', () => {
  it('seeds entries directly', async () => {
    const fake = new SessionStoreFake({ ttlSec: 60 });
    const data = buildSessionData({ sub: 'seeded' });
    fake.seed([{ sid: 'fixed-sid', data }]);
    const got = await fake.get('fixed-sid');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.sub).toBe('seeded');
  });
});
