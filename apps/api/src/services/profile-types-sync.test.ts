import { afterEach, describe, expect, it } from 'vitest';
import { IdpAdminFake } from './idp-admin/testing.js';
import { KC_ATTR } from './idp-admin/attributes.js';
import type { IdpResult } from './idp-admin/interface.js';
import { _setDbClients } from '../db/client.js';
import {
  listCoordinatorServesFromDb,
  syncCoordinatorProfileTypes,
  type CoordinatorServesRow,
} from './profile-types-sync.js';

const NETWORK = ['seeker', 'provider'];

/** Fake that counts writes and can fail every write. */
class CountingIdp extends IdpAdminFake {
  writes = 0;
  failWrites = false;
  override async setAttributes(
    userId: string,
    attributes: Record<string, string | string[] | null>,
  ): Promise<IdpResult<void>> {
    this.writes++;
    if (this.failWrites) {
      return { ok: false, error: { code: 'IDP_UNAVAILABLE', message: 'down' } };
    }
    return super.setAttributes(userId, attributes);
  }
}

/** Creates a Keycloak user for a coordinator, with its current `aggregator_type`. */
async function kcUser(idp: IdpAdminFake, aggregatorId: string, types?: string[]): Promise<string> {
  const created = await idp.createUser({
    email: `${aggregatorId}@x.org`,
    attributes: {
      [KC_ATTR.AGGREGATOR_ID]: aggregatorId,
      ...(types ? { [KC_ATTR.AGGREGATOR_TYPE]: types } : {}),
    },
  });
  if (!created.ok) throw new Error('seed failed');
  return created.value.id;
}

async function typesOf(idp: IdpAdminFake, kcId: string): Promise<string[] | undefined> {
  const u = await idp.findById(kcId);
  return u.ok ? u.value?.attributes?.[KC_ATTR.AGGREGATOR_TYPE] : undefined;
}

const row = (
  id: string,
  serves: string[],
  status: CoordinatorServesRow['status'] = 'active',
): CoordinatorServesRow => ({ id, serves, status });

function run(idp: IdpAdminFake, rows: CoordinatorServesRow[], dryRun = false) {
  return syncCoordinatorProfileTypes(
    { idp, listCoordinators: async () => rows, domainIds: NETWORK, retryDelayMs: 0 },
    { dryRun },
  );
}

describe('syncCoordinatorProfileTypes', () => {
  it('removes the attribute of a coordinator that serves nothing', async () => {
    const idp = new CountingIdp();
    const kc = await kcUser(idp, 'a1', ['seeker']);
    const report = await run(idp, [row('a1', [], 'pending')]);
    expect(await typesOf(idp, kc)).toBeUndefined();
    expect(report).toMatchObject({
      cleared: 1,
      emptyIds: ['a1'],
      emptyByStatus: { pending: 1 },
      unknownOnlyIds: [],
    });
  });

  it('clears a coordinator whose types are all unknown to the network', async () => {
    const idp = new CountingIdp();
    const kc = await kcUser(idp, 'a1', ['both']);
    const report = await run(idp, [row('a1', ['retired'])]);
    expect(await typesOf(idp, kc)).toBeUndefined();
    expect(report).toMatchObject({ cleared: 1, emptyIds: ['a1'], unknownOnlyIds: ['a1'] });
  });

  it('writes the served types in network order, without unknown ids', async () => {
    const idp = new CountingIdp();
    const kc = await kcUser(idp, 'a1', ['provider']);
    const report = await run(idp, [row('a1', ['provider', 'retired', 'seeker'])]);
    expect(await typesOf(idp, kc)).toEqual(['seeker', 'provider']);
    expect(report.set).toBe(1);
  });

  it('leaves a coordinator alone when Keycloak holds the same set', async () => {
    const idp = new CountingIdp();
    await kcUser(idp, 'a1', ['provider', 'seeker']);
    const report = await run(idp, [row('a1', ['seeker', 'provider'])]);
    expect(idp.writes).toBe(0);
    expect(report.inStep).toBe(1);
  });

  it('changes nothing on a second run', async () => {
    const idp = new CountingIdp();
    await kcUser(idp, 'a1', ['seeker']);
    await kcUser(idp, 'a2', ['seeker']);
    const rows = [row('a1', []), row('a2', ['seeker', 'provider'])];
    await run(idp, rows);
    const writes = idp.writes;
    const second = await run(idp, rows);
    expect(idp.writes).toBe(writes);
    expect(second).toMatchObject({ inStep: 2, set: 0, cleared: 0 });
  });

  it('writes nothing on a dry run but reports what would change', async () => {
    const idp = new CountingIdp();
    const kc = await kcUser(idp, 'a1', ['seeker']);
    await kcUser(idp, 'a2', ['seeker']);
    const report = await run(idp, [row('a1', []), row('a2', ['provider'])], true);
    expect(idp.writes).toBe(0);
    expect(await typesOf(idp, kc)).toEqual(['seeker']);
    expect(report).toMatchObject({ dryRun: true, cleared: 1, set: 1 });
  });

  it('counts a coordinator with no Keycloak user and carries on', async () => {
    const idp = new CountingIdp();
    await kcUser(idp, 'a2', []);
    const report = await run(idp, [row('a1', ['seeker']), row('a2', ['seeker'])]);
    expect(report.kcMissingIds).toEqual(['a1']);
    expect(report.set).toBe(1);
  });

  it('lists a coordinator whose write fails after the retry', async () => {
    const idp = new CountingIdp();
    await kcUser(idp, 'a1', ['seeker']);
    idp.failWrites = true;
    const report = await run(idp, [row('a1', ['provider'])]);
    expect(idp.writes).toBe(2);
    expect(report.failedIds).toEqual(['a1']);
    expect(report.set).toBe(0);
  });

  it('retries a failed lookup once', async () => {
    const idp = new CountingIdp();
    await kcUser(idp, 'a1', ['seeker']);
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'blip' });
    const report = await run(idp, [row('a1', ['seeker'])]);
    expect(report).toMatchObject({ inStep: 1, failedIds: [] });
  });
});

describe('listCoordinatorServesFromDb', () => {
  afterEach(() => _setDbClients(null, null));

  /** A Drizzle stand-in that answers each select with the next page and records the calls. */
  function fakeDb(pages: CoordinatorServesRow[][]) {
    const calls: string[] = [];
    const db = {
      select: () => {
        calls.push('select');
        const p = Promise.resolve(pages.shift() ?? []);
        for (const m of ['from', 'where', 'orderBy', 'limit']) {
          Object.defineProperty(p, m, {
            value: () => {
              calls.push(m);
              return p;
            },
          });
        }
        return p;
      },
    };
    return { db, calls };
  }

  it('reads every page until a short one', async () => {
    const full = Array.from({ length: 500 }, (_, i) => row(`id-${i}`, ['seeker']));
    const { db, calls } = fakeDb([full, [row('last', [])]]);
    _setDbClients(null, db as never);
    const rows = await listCoordinatorServesFromDb();
    expect(rows).toHaveLength(501);
    expect(calls.filter((c) => c === 'select')).toHaveLength(2);
    expect(calls).not.toContain('update');
  });
});
