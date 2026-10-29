/**
 * Unit tests for PostgresOrganisationStore.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built stub mimicking
 * its fluent, thenable query-builder chain (per testing.md §1 — third-party
 * adapters may be stubbed rather than faked), matching the pattern in
 * `packages/consent-ledger/src/__tests__/consent-ledger.test.ts`.
 * Every chained call is recorded so a test can assert on the exact values
 * passed into `.values()` / `.set()`, and the terminal `await` resolves to
 * whatever the test configures — this exercises the real
 * insert/CAS-approve/error-mapping logic in `postgres.ts` without a live
 * database.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PostgresOrganisationStore } from '../postgres.js';
import { _setDbClients } from '../../../db/client.js';
import { NO_CONSENT_WRITE } from '../../consent-ledger/hook.js';
import type { Organisation, CreateOrgInput } from '../interface.js';

// ─── Fake Drizzle chain ─────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeFakeDb(resolveRaw: (chain: ChainCall[]) => unknown): unknown {
  // Reads go through `aggregator_orgs JOIN contact` (migration 0025) and
  // resolve to `{ o, c }` pairs. Tests keep returning flat rows; wrap them
  // here, deriving the joined contact from the fixture's owner fields.
  const resolve = (chain: ChainCall[]): unknown => {
    // Raw SQL: the admin-account link reads `id`; ownerIsShared reads `shared`.
    if (chain[0]?.method === 'execute') return { rows: [{ n: 1, id: 'admin-1', shared: false }] };
    const out = resolveRaw(chain);
    if (!chain.some((c) => c.method === 'innerJoin') || !Array.isArray(out)) return out;
    return out.map((r: Record<string, unknown>) =>
      'o' in r
        ? r
        : {
            // The fixture is a domain row; the table columns follow 0028.
            o: {
              ...r,
              name: r['displayName'],
              orgOwner: r['ownerUserId'],
              orgType: 'aggregator',
              url: r['url'] ?? null,
              locations: r['locations'] ?? [],
              legalName: r['legalName'] ?? null,
              gstNumber: r['gstNumber'] ?? null,
            },
            ownerKcSub: (r['ownerKcSub'] as string | null) ?? null,
            parentName: (r['parentName'] as string | null) ?? null,
            c: {
              id: 'c'.repeat(64),
              email: String(r['ownerEmail']).toLowerCase(),
              phone: (r['ownerPhone'] as string | null) ?? null,
              name: (r['ownerName'] as string | null) ?? null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          },
    );
  };
  function build(chain: ChainCall[]): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop: string | symbol) {
          if (prop === 'transaction') {
            // Run the callback against a fresh chain, like Drizzle does.
            return (fn: (tx: unknown) => Promise<unknown>) => fn(build([]));
          }
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
              let result: unknown;
              try {
                result = resolve(chain);
              } catch (e) {
                return onRejected ? Promise.resolve(onRejected(e)) : Promise.reject(e);
              }
              return Promise.resolve(result).then(onFulfilled, onRejected);
            };
          }
          if (prop === 'catch') {
            return (onRejected: (e: unknown) => unknown) =>
              (build(chain) as Promise<unknown>).then(undefined, onRejected);
          }
          return (...args: unknown[]) => build([...chain, { method: String(prop), args }]);
        },
      },
    );
  }
  return build([]);
}

function callArgs(chain: ChainCall[], method: string): unknown[] | undefined {
  return chain.find((c) => c.method === method)?.args;
}

/** Whether `chain` is the INSERT/UPDATE of the `aggregator_orgs` row itself. */
function isOrgWrite(chain: ChainCall[]): boolean {
  const values = callArgs(chain, 'values')?.[0] as Record<string, unknown> | undefined;
  const set = callArgs(chain, 'set')?.[0] as Record<string, unknown> | undefined;
  return values?.['slug'] !== undefined || set?.['updatedAt'] !== undefined;
}

afterEach(() => {
  _setDbClients(null, null);
});

function makeRow(overrides: Partial<Organisation> = {}): Organisation {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    slug: 'test-org',
    displayName: 'Test Org',
    state: null,
    contactId: 'a'.repeat(64),
    ownerUserId: 'admin-1',
    ownerEmail: 'owner@test.local',
    ownerPhone: null,
    ownerName: null,
    ownerKcSub: null,
    kcGroupId: null,
    profile: {},
    profileRef: null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    updatedBy: null,
    rejectedAt: null,
    isDefault: false,
    url: null,
    locations: [],
    legalName: null,
    gstNumber: null,
    knownAs: 'aggregator',
    parentId: null,
    parentName: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateOrgInput> = {}): CreateOrgInput {
  return {
    slug: 'test-org',
    displayName: 'Test Org',
    ownerEmail: 'owner@test.local',
    recordConsent: NO_CONSENT_WRITE,
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe('PostgresOrganisationStore.create', () => {
  it('inserts the mapped row linked to the owner contact', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ ownerEmail: 'owner@test.local' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput({ ownerEmail: 'OWNER@TEST.LOCAL' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ownerEmail).toBe('owner@test.local');
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      slug: 'test-org',
      name: 'Test Org',
      // Every new org is an aggregator under the network root (0028).
      orgType: 'aggregator',
      // The owner is an admin account (0027) linked to the owner's contact;
      // the org row holds no contact or IdP copy of its own.
      orgOwner: 'admin-1',
      state: null,
      kcGroupId: null,
    });
    const orgValues = callArgs(captured, 'values')?.[0] as Record<string, unknown>;
    expect(orgValues).not.toHaveProperty('contactId');
    expect(orgValues).not.toHaveProperty('ownerKcSub');
  });

  it('returns DB_UNAVAILABLE when insert returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a display-name unique violation (SQLSTATE 23505 + constraint) to DUPLICATE_NAME', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'organisations_name_live_unique',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_NAME');
  });

  it('maps a slug unique violation (SQLSTATE 23505 + constraint) to DUPLICATE_SLUG', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'organisations_slug_live_unique',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it.each([
    ['contact_email_unique', 'DUPLICATE_EMAIL'],
    ['contact_phone_unique', 'DUPLICATE_PHONE'],
  ] as const)('maps a %s violation (another person) to %s', async (constraint, code) => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), { code: '23505', constraint });
    });
    _setDbClients(null, db as never);
    const result = await new PostgresOrganisationStore().create(makeInput());
    expect(result.ok || result.error.code).toBe(code);
  });

  it('does NOT misreport a connection error whose query text names a constraint (M2)', async () => {
    // No SQLSTATE 23505 → must be DB_UNAVAILABLE even though the message text
    // mentions the unique index (Drizzle puts the query text on `.message`).
    const db = makeFakeDb(() => {
      throw Object.assign(
        new Error('Failed query: insert ... organisations_name_live_unique ...'),
        { cause: new Error('connection terminated') },
      );
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a display-name violation wrapped by Drizzle (constraint on .cause) to DUPLICATE_NAME', async () => {
    // Real Drizzle shape: outer `.message` is the query text; the pg driver
    // error (SQLSTATE 23505 + `constraint`) is on `.cause`. Regression guard
    // for the 503-instead-of-409 misclassification.
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(
        new Error(
          'duplicate key value violates unique constraint "organisations_name_live_unique"',
        ),
        { code: '23505', constraint: 'organisations_name_live_unique' },
      );
      throw Object.assign(new Error('Failed query: insert into "aggregator_orgs" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_NAME');
  });

  it('maps a slug violation wrapped by Drizzle (constraint on .cause) to DUPLICATE_SLUG', async () => {
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(new Error('duplicate key value ...'), {
        code: '23505',
        constraint: 'organisations_slug_live_unique',
      });
      throw Object.assign(new Error('Failed query: insert into "aggregator_orgs" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it('maps any other driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
    // The driver message carries query parameters; it is never echoed.
    expect(result.error.message).not.toContain('connection reset');
  });
});

// ─── findById / findBySlug / findByOwnerEmail (findOne) ────────────────────

describe('PostgresOrganisationStore.findById / findBySlug / findByOwnerEmail', () => {
  it('findById returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findById('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe('org-1');
  });

  it('findById returns null when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findById('missing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('findById returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findById('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('findBySlug returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ slug: 'acme' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();
    const result = await store.findBySlug('acme');
    expect(result.ok && result.value?.slug).toBe('acme');
  });

  it('findByOwnerEmail lowercases the lookup value and returns the mapped row', async () => {
    const db = makeFakeDb(() => [makeRow({ ownerEmail: 'mixed@x.org' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findByOwnerEmail('MIXED@X.ORG');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.ownerEmail).toBe('mixed@x.org');
  });

  it('findByOwnerPhone returns the org whose owner contact holds the phone', async () => {
    const db = makeFakeDb(() => [makeRow({ ownerPhone: '+919000000009' })]);
    _setDbClients(null, db as never);
    const result = await new PostgresOrganisationStore().findByOwnerPhone('+919000000009');
    expect(result.ok && result.value?.ownerPhone).toBe('+919000000009');
  });

  it('findByOwnerEmail returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.findByOwnerEmail('a@x.org');
    expect(result.ok).toBe(false);
  });
});

// ─── listActive / listPending ───────────────────────────────────────────────

describe('PostgresOrganisationStore.listActive', () => {
  it('returns the mapped active rows', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-1', status: 'active' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listActive();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.status).toBe('active');
  });

  it('returns an empty array when there are no active orgs', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listActive();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listActive();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('PostgresOrganisationStore.listPending', () => {
  it('builds a compound where clause when updatedBefore is given', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ status: 'pending' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listPending(new Date('2026-01-01T00:00:00Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(callArgs(captured, 'where')?.[0]).toBeDefined();
  });

  it('filters on status=pending only when updatedBefore is omitted', async () => {
    const db = makeFakeDb(() => [makeRow({ status: 'pending' })]);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listPending();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.listPending();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── update ─────────────────────────────────────────────────────────────────

describe('PostgresOrganisationStore.update', () => {
  it('merges the patch and stamps updatedAt', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ displayName: 'New Name' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.update('org-1', { displayName: 'New Name' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.displayName).toBe('New Name');
    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ name: 'New Name' });
    expect(set).toHaveProperty('updatedAt');
  });

  it('returns NOT_FOUND when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.update('missing', { displayName: 'X' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.update('org-1', { displayName: 'X' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── deleteById ─────────────────────────────────────────────────────────────

describe('PostgresOrganisationStore.deleteById', () => {
  it('returns ok(void) on success', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.deleteById('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.deleteById('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── approve / reject (casFromPending) ──────────────────────────────────────

describe('PostgresOrganisationStore.approve / reject', () => {
  it('approve returns the updated row on a successful CAS', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ status: 'active' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.approve('org-1', 'admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.status).toBe('active');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ status: 'active' });
  });

  it('approve returns ok(null) when the row was not pending', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.approve('org-1', 'admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('reject returns the updated row with status=inactive', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      // A write runs contact statements, then the org statement, then a
      // joined re-read; keep the org write (or the first read).
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ status: 'inactive' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.reject('org-1', 'admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.status).toBe('inactive');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ status: 'inactive' });
  });

  it('reject returns ok(null) when the row was not pending', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.reject('org-1', 'admin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const result = await store.approve('org-1', 'admin');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('PostgresOrganisationStore — consent in the create transaction (0029)', () => {
  it('runs recordConsent inside the transaction with the new org id', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-7', ownerEmail: 'owner@test.local' })]);
    _setDbClients(null, db as never);
    const calls: { tx: unknown; id: string }[] = [];
    const result = await new PostgresOrganisationStore().create(
      makeInput({
        recordConsent: async (tx, id) => {
          calls.push({ tx, id });
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tx).toBeDefined();
  });

  it('answers CONSENT_WRITE_FAILED when the hook throws (the transaction rolls back)', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-8', ownerEmail: 'owner@test.local' })]);
    _setDbClients(null, db as never);
    const result = await new PostgresOrganisationStore().create(
      makeInput({
        recordConsent: async () => {
          throw new Error('ledger down');
        },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'CONSENT_WRITE_FAILED', message: 'consent could not be recorded' },
    });
  });
});

/** Every string literal inside a Drizzle `sql` object (visited once each). */
function sqlText(node: unknown, seen = new Set<unknown>()): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object' || seen.has(node)) return '';
  seen.add(node);
  return Object.values(node as Record<string, unknown>)
    .map((v) => sqlText(v, seen))
    .join(' ');
}

describe('PostgresOrganisationStore.search — descendantsOf', () => {
  it('adds a recursive subtree filter only when descendantsOf is set', async () => {
    const wheres: unknown[] = [];
    const db = makeFakeDb((chain) => {
      wheres.push(callArgs(chain, 'where')?.[0]);
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();

    const below = await store.search({ orgIds: null, descendantsOf: 'state-id' });
    expect(below.ok && below.value.rows).toHaveLength(1);
    await store.search({ orgIds: null });

    expect(sqlText(wheres[0])).toContain('WITH RECURSIVE');
    expect(sqlText(wheres[1])).not.toContain('WITH RECURSIVE');
  });
});

describe('PostgresOrganisationStore — known_as and parents', () => {
  it('update writes known_as and parent_id from the patch', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (isOrgWrite(chain) || captured.length === 0) captured = chain;
      return [makeRow({ knownAs: 'district', parentId: 'p1', parentName: 'Parent' })];
    });
    _setDbClients(null, db as never);
    const r = await new PostgresOrganisationStore().update('org-1', {
      knownAs: 'district',
      parentId: 'p1',
    });
    expect(r.ok && [r.value.knownAs, r.value.parentId]).toEqual(['district', 'p1']);
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ knownAs: 'district', parentId: 'p1' });
  });

  it('search adds a known_as filter only when given', async () => {
    const wheres: unknown[] = [];
    const db = makeFakeDb((chain) => {
      wheres.push(callArgs(chain, 'where')?.[0]);
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresOrganisationStore();
    await store.search({ orgIds: null, knownAs: 'district' });
    await store.search({ orgIds: null });
    const render = (w: unknown) => new PgDialect().sqlToQuery(w as SQL).sql;
    expect(render(wheres[0])).toContain('"known_as" = ');
    expect(render(wheres[1])).not.toContain('"known_as"');
  });

  it('descendantIds runs one recursive query and leaves out the given ids', async () => {
    // The fake answers raw SQL with the row id 'admin-1': a given id, so it is left out.
    _setDbClients(null, makeFakeDb(() => []) as never);
    const r = await new PostgresOrganisationStore().descendantIds(['admin-1']);
    expect(r.ok && r.value).toEqual([]);
    expect(await new PostgresOrganisationStore().descendantIds([])).toEqual({
      ok: true,
      value: [],
    });
  });

  it('descendantIds returns DB_UNAVAILABLE when the driver throws', async () => {
    const failing = {
      execute: () => Promise.reject(Object.assign(new Error('boom'), { code: '57P01' })),
    };
    _setDbClients(null, failing as never);
    const r = await new PostgresOrganisationStore().descendantIds(['p']);
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });

  it('hasChildren is true when a row has the org as parent', async () => {
    _setDbClients(null, makeFakeDb(() => [{ id: 'c1' }]) as never);
    expect(await new PostgresOrganisationStore().hasChildren('p')).toEqual({
      ok: true,
      value: true,
    });
    _setDbClients(null, makeFakeDb(() => []) as never);
    expect(await new PostgresOrganisationStore().hasChildren('p')).toEqual({
      ok: true,
      value: false,
    });
  });

  it('countByKnownAs maps grouped rows to a count per key', async () => {
    const db = makeFakeDb(() => [
      { key: 'state', n: 3 },
      { key: 'district', n: '1' },
    ]);
    _setDbClients(null, db as never);
    const r = await new PostgresOrganisationStore().countByKnownAs();
    expect(r.ok && r.value).toEqual({ state: 3, district: 1 });
  });

  it.each(['hasChildren', 'countByKnownAs'] as const)(
    '%s returns DB_UNAVAILABLE when the driver throws',
    async (op) => {
      const db = makeFakeDb(() => {
        throw new Error('boom');
      });
      _setDbClients(null, db as never);
      const store = new PostgresOrganisationStore();
      const r = op === 'hasChildren' ? await store.hasChildren('p') : await store.countByKnownAs();
      expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
    },
  );
});
