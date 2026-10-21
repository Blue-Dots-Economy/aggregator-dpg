/**
 * Unit tests for RBAC boot-time init and the role snapshot refresh
 * (`@aggregator-dpg/api`; design §5). The built-in roles are seeded into the
 * database by migration 0031; here the in-memory catalogue stands in for that
 * seed via `setRoles(BUILTIN_ROLES)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_ROLES } from '@aggregator-dpg/rbac';
import { buildRole } from '@aggregator-dpg/rbac/testing';
import {
  getRbacRuntime,
  initRbac,
  refreshRbacCatalogue,
  stopRbacRefresh,
  _setRbacRuntime,
} from '../runtime.js';
import { InMemoryRbacCatalogue, _setRbacCatalogue } from '../../rbac-catalogue/index.js';

let store: InMemoryRbacCatalogue;

beforeEach(() => {
  store = new InMemoryRbacCatalogue();
  // The catalogue as migration 0031 leaves it at start: the built-in roles seeded.
  store.setRoles(BUILTIN_ROLES);
  _setRbacCatalogue(store);
});

afterEach(() => {
  stopRbacRefresh();
  _setRbacRuntime(null);
  _setRbacCatalogue(null);
  vi.useRealTimers();
});

const viewer = buildRole({ key: 'viewer', permissions: ['profiles.view'] });
const roleKeys = () => [...getRbacRuntime()!.roles.byKey.keys()].sort();

describe('initRbac', () => {
  it('loads nothing when off', async () => {
    await initRbac('off');
    expect(getRbacRuntime()).toBeNull();
  });

  it('loads the seeded built-in roles', async () => {
    await initRbac('enforce', 0);
    expect(roleKeys()).toEqual([
      'coordinator',
      'data_export',
      'network_admin',
      'org_admin',
      'org_onboarder',
      'pii_access',
    ]);
    expect(getRbacRuntime()).toMatchObject({ mode: 'enforce', catalogueRevision: 'r1' });
  });

  it('loads custom roles alongside the built-ins', async () => {
    store.setRoles([...store.storedRoles(), viewer]);
    await initRbac('log', 0);
    expect(roleKeys()).toContain('viewer');
  });

  it('fails boot when the store is down', async () => {
    store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
    await expect(initRbac('log', 0)).rejects.toMatchObject({ code: 'RBAC_CATALOGUE_UNAVAILABLE' });
  });

  it('fails boot when a stored role breaks a rule', async () => {
    store.setRoles([...store.storedRoles(), buildRole({ key: 'bad', assignedBy: null })]);
    await expect(initRbac('log', 0)).rejects.toMatchObject({ code: 'RBAC_CONFIG_INVALID' });
  });
});

describe('refreshRbacCatalogue', () => {
  it('does nothing when RBAC is off', async () => {
    await initRbac('off');
    expect(await refreshRbacCatalogue()).toBe('off');
  });

  it('keeps the snapshot when the revision did not change', async () => {
    await initRbac('log', 0);
    const before = getRbacRuntime();
    expect(await refreshRbacCatalogue()).toBe('unchanged');
    expect(getRbacRuntime()).toBe(before);
  });

  it('reloads when a role changed', async () => {
    await initRbac('log', 0);
    store.setRoles([...store.storedRoles(), viewer]);
    expect(await refreshRbacCatalogue()).toBe('reloaded');
    expect(roleKeys()).toContain('viewer');
    expect(getRbacRuntime()!.catalogueRevision).toBe('r2');
  });

  it('keeps the last good snapshot when the new catalogue is invalid', async () => {
    await initRbac('log', 0);
    const before = getRbacRuntime()!.roles;
    store.setRoles(store.storedRoles().filter((r) => r.key !== 'org_admin'));
    expect(await refreshRbacCatalogue()).toBe('failed');
    expect(getRbacRuntime()!.roles).toBe(before);
    expect(getRbacRuntime()!.catalogueRevision).toBe('r1');
  });

  it('keeps the snapshot when the store is down', async () => {
    await initRbac('log', 0);
    const before = getRbacRuntime();
    store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
    expect(await refreshRbacCatalogue()).toBe('failed');
    expect(getRbacRuntime()).toBe(before);
  });

  it('shares one run between overlapping calls', async () => {
    await initRbac('log', 0);
    store.setRoles([...store.storedRoles(), viewer]);
    const load = vi.spyOn(store, 'load');
    const [a, b] = await Promise.all([refreshRbacCatalogue(), refreshRbacCatalogue()]);
    expect([a, b]).toEqual(['reloaded', 'reloaded']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('runs on the timer and stops with stopRbacRefresh', async () => {
    vi.useFakeTimers();
    await initRbac('log', 1000);
    const builtins = store.storedRoles();
    store.setRoles([...builtins, viewer]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(roleKeys()).toContain('viewer');

    stopRbacRefresh();
    store.setRoles(builtins);
    await vi.advanceTimersByTimeAsync(5000);
    expect(roleKeys()).toContain('viewer');
  });
});
