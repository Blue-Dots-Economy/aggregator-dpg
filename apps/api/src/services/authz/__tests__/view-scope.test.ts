/**
 * Unit tests for the read-only reach below an owner's organisations.
 *
 * Covers: adding descendants, keeping `null` (every org) and an empty reach,
 * a store failure, and which orgs are only viewed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OrganisationStoreFake,
  _setOrganisationStore,
  buildOrganisation,
} from '../../organisation-store/index.js';
import { isOnlyViewed, viewableOrgIds, withOrgsBelow } from '../view-scope.js';
import type { Actor } from '../../auth/actor/index.js';

const owner = (orgIds: string[]): Actor =>
  ({
    userId: 'u1',
    userType: 'admin',
    orgs: orgIds.map((id) => ({ id, orgType: 'aggregator', relation: 'owner' })),
  }) as unknown as Actor;

function seedTree(): OrganisationStoreFake {
  const store = new OrganisationStoreFake();
  store.seed([
    buildOrganisation({ id: 's', slug: 's' }),
    buildOrganisation({ id: 'd', slug: 'd', parentId: 's' }),
    buildOrganisation({ id: 'a', slug: 'a', parentId: 'd' }),
    buildOrganisation({ id: 'x', slug: 'x' }),
  ]);
  _setOrganisationStore(store);
  return store;
}

afterEach(() => _setOrganisationStore(null));

describe('withOrgsBelow', () => {
  it('adds every org below the given ones', async () => {
    seedTree();
    const r = await withOrgsBelow(['s']);
    expect(r.ok && [...(r.value ?? [])].sort()).toEqual(['a', 'd', 's']);
  });

  it('keeps null (every org) and an empty list as they are', async () => {
    seedTree();
    expect(await withOrgsBelow(null)).toEqual({ ok: true, value: null });
    expect(await withOrgsBelow([])).toEqual({ ok: true, value: [] });
  });

  it('passes a store failure on', async () => {
    const store = seedTree();
    vi.spyOn(store, 'descendantIds').mockResolvedValueOnce({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    const r = await withOrgsBelow(['s']);
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('viewableOrgIds / isOnlyViewed', () => {
  it('lets an owner read its org and everything below, not a sibling', async () => {
    seedTree();
    const r = await viewableOrgIds(owner(['s']));
    expect(r.ok && [...(r.value ?? [])].sort()).toEqual(['a', 'd', 's']);
  });

  it('marks orgs below an owner as only viewed, its own as not', () => {
    const actor = owner(['s']);
    expect(isOnlyViewed(actor, 's')).toBe(false);
    expect(isOnlyViewed(actor, 'd')).toBe(true);
    expect(isOnlyViewed(actor, null)).toBe(true);
  });
});
