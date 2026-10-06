/**
 * Unit tests for the Postgres identity store (`@aggregator-dpg/api`): error
 * mapping over `db/account-writes.ts`, with `getDb()` swapped for a scripted
 * fake. Real-database behaviour is in `users.integration.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { _setDbClients } from '../../../db/client.js';
import { PostgresIdentityStore } from '../postgres.js';

afterEach(() => _setDbClients(null, null));

function fakeDb(opts: { execRows?: unknown[]; selectRows?: unknown[]; fail?: boolean }) {
  const chain = (rows: unknown): Promise<unknown> => {
    const p = opts.fail
      ? Promise.reject(Object.assign(new Error('x'), { code: '08006' }))
      : Promise.resolve(rows);
    p.catch(() => undefined);
    for (const m of ['from', 'where']) Object.defineProperty(p, m, { value: () => p });
    return p;
  };
  return {
    execute: () =>
      opts.fail
        ? Promise.reject(Object.assign(new Error('x'), { code: '08006' }))
        : Promise.resolve({ rows: opts.execRows ?? [] }),
    select: () => chain(opts.selectRows ?? []),
  };
}

describe('PostgresIdentityStore', () => {
  it('maps a recorded link to linked', async () => {
    _setDbClients(null, fakeDb({ execRows: [{ user_id: 'u1' }] }) as never);
    expect(await new PostgresIdentityStore().link('u1', 'keycloak', 's')).toEqual({
      ok: true,
      value: 'linked',
    });
  });

  it('maps a subject owned elsewhere to DUPLICATE and a changed subject to MISMATCH', async () => {
    _setDbClients(null, fakeDb({ execRows: [], selectRows: [] }) as never);
    const dup = await new PostgresIdentityStore().link('u1', 'keycloak', 's');
    expect(dup.ok || dup.error.code).toBe('DUPLICATE');
    _setDbClients(null, fakeDb({ execRows: [], selectRows: [{ subject: 'other' }] }) as never);
    const mm = await new PostgresIdentityStore().link('u1', 'keycloak', 's');
    expect(mm.ok || mm.error.code).toBe('MISMATCH');
  });

  it('maps a driver failure to DB_UNAVAILABLE on every method', async () => {
    _setDbClients(null, fakeDb({ fail: true }) as never);
    const s = new PostgresIdentityStore();
    for (const r of [
      await s.link('u1', 'keycloak', 's'),
      await s.subjectOf('u1', 'keycloak'),
      await s.userOf('keycloak', 's'),
    ]) {
      expect(r.ok || r.error.code).toBe('DB_UNAVAILABLE');
    }
  });

  it('reads subjectOf / userOf', async () => {
    _setDbClients(null, fakeDb({ selectRows: [{ subject: 's1', userId: 'u1' }] }) as never);
    const s = new PostgresIdentityStore();
    expect(await s.subjectOf('u1', 'keycloak')).toEqual({ ok: true, value: 's1' });
    expect(await s.userOf('keycloak', 's1')).toEqual({ ok: true, value: 'u1' });
  });
});
