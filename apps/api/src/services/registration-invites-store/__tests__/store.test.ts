/**
 * Unit tests for the registration-invites store (#700).
 *
 * In-memory tests exercise the behavioural contract (partial-unique pending,
 * CAS consume/revoke, refresh-only-when-pending). A small Postgres block covers
 * the driver-error mapping the in-memory impl can't reach (DUPLICATE_PENDING
 * from a wrapped SQLSTATE 23505, and the DB_UNAVAILABLE fallback).
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryRegistrationInvitesStore,
  RegistrationInvitesStoreFake,
  buildRegistrationInvite,
  PostgresRegistrationInvitesStore,
} from '../index.js';
import { _setDbClients } from '../../../db/client.js';

const ORG = '00000000-0000-0000-0000-0000000000aa';

describe('InMemoryRegistrationInvitesStore', () => {
  const input = {
    parentOrgId: ORG,
    email: 'a@x.org',
    expiresAt: new Date('2027-01-01'),
    createdBy: 'owner',
  };

  it('creates a pending invite and finds it by jti', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const created = await s.create(input);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.status).toBe('pending');
    expect(created.value.role).toBe('coordinator');
    const found = await s.findByJti(created.value.jti);
    expect(found.ok && found.value?.email).toBe('a@x.org');
  });

  it('rejects a second live invite for the same (org, email) with DUPLICATE_PENDING', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    await s.create(input);
    const dup = await s.create(input);
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error.code).toBe('DUPLICATE_PENDING');
  });

  it('allows a new invite once the prior one is consumed (partial-unique is pending-only)', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const first = await s.create(input);
    if (!first.ok) throw new Error('seed');
    await s.consume(first.value.jti);
    const second = await s.create(input);
    expect(second.ok).toBe(true);
  });

  it('findPendingByOrgAndEmail returns only pending rows', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    let hit = await s.findPendingByOrgAndEmail(ORG, 'a@x.org');
    expect(hit.ok && hit.value?.jti).toBe(c.value.jti);
    await s.consume(c.value.jti);
    hit = await s.findPendingByOrgAndEmail(ORG, 'a@x.org');
    expect(hit.ok && hit.value).toBeNull();
  });

  it('refresh extends a pending invite; NOT_FOUND once terminal', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    const later = new Date('2028-01-01');
    const r = await s.refresh(c.value.jti, { expiresAt: later, createdBy: 'owner2' });
    expect(r.ok && r.value.expiresAt).toEqual(later);
    expect(r.ok && r.value.createdBy).toBe('owner2');
    await s.revoke(c.value.jti);
    const r2 = await s.refresh(c.value.jti, { expiresAt: later, createdBy: 'owner2' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('NOT_FOUND');
  });

  it('consume is a single-use CAS: second consume returns null', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    const first = await s.consume(c.value.jti);
    expect(first.ok && first.value?.status).toBe('consumed');
    expect(first.ok && first.value?.consumedAt).toBeInstanceOf(Date);
    const second = await s.consume(c.value.jti);
    expect(second.ok && second.value).toBeNull();
  });

  it('revoke a pending invite; revoking a consumed one is a null no-op', async () => {
    const s = new InMemoryRegistrationInvitesStore();
    const c = await s.create(input);
    if (!c.ok) throw new Error('seed');
    const rev = await s.revoke(c.value.jti);
    expect(rev.ok && rev.value?.status).toBe('revoked');
    const c2 = await s.create(input);
    if (!c2.ok) throw new Error('seed2');
    await s.consume(c2.value.jti);
    const rev2 = await s.revoke(c2.value.jti);
    expect(rev2.ok && rev2.value).toBeNull();
  });

  it('fake.seed() sets exact row state', async () => {
    const s = new RegistrationInvitesStoreFake();
    s.seed([buildRegistrationInvite({ jti: 'seeded', status: 'pending' })]);
    const found = await s.findByJti('seeded');
    expect(found.ok && found.value?.jti).toBe('seeded');
  });
});

// ─── Postgres error mapping (fake Drizzle chain) ────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}
function makeFakeDb(resolve: () => unknown): unknown {
  function build(chain: ChainCall[]): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (prop === 'then') {
            return (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
              try {
                return Promise.resolve(resolve()).then(onF, onR);
              } catch (e) {
                return onR ? Promise.resolve(onR(e)) : Promise.reject(e);
              }
            };
          }
          return (...args: unknown[]) => build([...chain, { method: String(prop), args }]);
        },
      },
    );
  }
  return build([]);
}

describe('PostgresRegistrationInvitesStore error mapping', () => {
  afterEach(() => _setDbClients(null, null));

  it('maps a Drizzle-wrapped 23505 (constraint on .cause) to DUPLICATE_PENDING', async () => {
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'registration_invites_pending_unique',
      });
      throw Object.assign(new Error('Failed query: insert into "registration_invites" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationInvitesStore();
    const res = await store.create({
      parentOrgId: ORG,
      email: 'a@x.org',
      expiresAt: new Date('2027-01-01'),
      createdBy: 'owner',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('DUPLICATE_PENDING');
  });

  it('maps any other driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresRegistrationInvitesStore();
    const res = await store.consume('some-jti');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('DB_UNAVAILABLE');
  });
});
