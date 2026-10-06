/**
 * Unit tests for the actor resolvers (`@aggregator-dpg/api`, RBAC R0): the
 * in-memory resolver, and the Postgres resolver over a scripted fake `getDb()`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { _setDbClients } from '../../../db/client.js';
import {
  DEFAULT_ORG_PLACEHOLDER,
  InMemoryActorResolver,
  PostgresActorResolver,
  getActorResolver,
  _setActorResolver,
} from '../actor-resolver/index.js';

afterEach(() => {
  _setDbClients(null, null);
  _setActorResolver(null);
});

/** A fake `db` whose successive `select()` chains resolve to the given rows. */
function fakeDb(results: unknown[][], fail = false) {
  let i = 0;
  return {
    select: () => {
      const rows = results[i++] ?? [];
      const p = fail
        ? Promise.reject(Object.assign(new Error('x'), { code: '08006' }))
        : Promise.resolve(rows);
      p.catch(() => undefined);
      for (const m of ['from', 'where']) Object.defineProperty(p, m, { value: () => p });
      return p;
    },
  };
}

describe('PostgresActorResolver', () => {
  it('resolves a coordinator by aggregator_id with its parent org', async () => {
    _setDbClients(
      null,
      fakeDb([[{ userType: 'coordinator', status: 'active', parentOrgId: 'org-a' }]]) as never,
    );
    const res = await new PostgresActorResolver().resolve({ subject: 's', aggregatorId: 'u1' });
    expect(res).toEqual({
      ok: true,
      value: {
        userId: 'u1',
        userType: 'coordinator',
        active: true,
        orgs: [{ id: 'org-a', orgType: 'aggregator', relation: 'member', permissionSet: null }],
        grants: [],
      },
    });
  });

  it('puts a flat coordinator in the default org placeholder', async () => {
    _setDbClients(
      null,
      fakeDb([[{ userType: 'coordinator', status: 'pending', parentOrgId: null }]]) as never,
    );
    const res = await new PostgresActorResolver().resolve({ subject: 's', aggregatorId: 'u1' });
    expect(res.ok && res.value?.orgs[0]?.id).toBe(DEFAULT_ORG_PLACEHOLDER);
    expect(res.ok && res.value?.active).toBe(false);
  });

  it('resolves an admin by subject with the active orgs it owns', async () => {
    _setDbClients(
      null,
      fakeDb([
        [{ userId: 'adm' }],
        [{ userType: 'admin', status: null, parentOrgId: null }],
        [{ id: 'o1' }, { id: 'o2' }],
      ]) as never,
    );
    const res = await new PostgresActorResolver().resolve({ subject: 'kc-sub' });
    expect(res.ok && res.value).toMatchObject({
      userId: 'adm',
      userType: 'admin',
      active: true,
      orgs: [
        { id: 'o1', relation: 'owner' },
        { id: 'o2', relation: 'owner' },
      ],
    });
  });

  it('marks an admin with no active org inactive', async () => {
    _setDbClients(
      null,
      fakeDb([
        [{ userId: 'adm' }],
        [{ userType: 'admin', status: null, parentOrgId: null }],
        [],
      ]) as never,
    );
    const res = await new PostgresActorResolver().resolve({ subject: 'kc-sub' });
    expect(res.ok && res.value?.active).toBe(false);
  });

  it('returns null for an unknown subject', async () => {
    _setDbClients(null, fakeDb([[]]) as never);
    expect(await new PostgresActorResolver().resolve({ subject: 'nobody' })).toEqual({
      ok: true,
      value: null,
    });
  });

  it('returns null when the user row is gone', async () => {
    _setDbClients(null, fakeDb([[]]) as never);
    expect(
      await new PostgresActorResolver().resolve({ subject: 's', aggregatorId: 'gone' }),
    ).toEqual({
      ok: true,
      value: null,
    });
  });

  it('maps a driver failure to DB_UNAVAILABLE', async () => {
    _setDbClients(null, fakeDb([], true) as never);
    const res = await new PostgresActorResolver().resolve({ subject: 's', aggregatorId: 'u1' });
    expect(res).toEqual({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'database unavailable' },
    });
  });

  it('returns the organisation alone as its chain', async () => {
    expect(await new PostgresActorResolver().orgChain('o1')).toEqual({ ok: true, value: ['o1'] });
  });
});

describe('InMemoryActorResolver', () => {
  const actor = { userId: 'u1', userType: 'admin' as const, active: true, orgs: [], grants: [] };

  it('resolves by aggregator_id or by subject', async () => {
    const r = new InMemoryActorResolver();
    r.seed(actor, 'kc-1');
    expect((await r.resolve({ subject: 'x', aggregatorId: 'u1' })).ok).toBe(true);
    expect(await r.resolve({ subject: 'kc-1' })).toEqual({ ok: true, value: actor });
    expect(await r.resolve({ subject: 'other' })).toEqual({ ok: true, value: null });
  });

  it('walks the parent chain and stops on a cycle', async () => {
    const r = new InMemoryActorResolver();
    r.seedParent('c', 'b');
    r.seedParent('b', 'a');
    r.seedParent('a', 'c');
    expect(await r.orgChain('c')).toEqual({ ok: true, value: ['c', 'b', 'a'] });
  });
});

describe('getActorResolver', () => {
  it('returns a shared Postgres resolver by default', () => {
    expect(getActorResolver()).toBeInstanceOf(PostgresActorResolver);
    expect(getActorResolver()).toBe(getActorResolver());
  });
});
