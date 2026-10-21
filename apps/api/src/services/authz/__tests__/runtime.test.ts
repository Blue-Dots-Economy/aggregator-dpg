/**
 * Unit tests for RBAC boot-time init and the role snapshot refresh
 * (`@aggregator-dpg/api`; design §5).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRole } from '@aggregator-dpg/rbac/testing';
import {
  getRbacRuntime,
  initRbac,
  rbacConfigCandidates,
  refreshRbacCatalogue,
  stopRbacRefresh,
  _setRbacRuntime,
} from '../runtime.js';
import { InMemoryRbacCatalogue, _setRbacCatalogue } from '../../rbac-catalogue/index.js';
import { config } from '../../../config.js';

const savedRoot = process.env.CONFIG_ROOT;
const savedCustomRoles = config.RBAC_CUSTOM_ROLES_ENABLED;
let store: InMemoryRbacCatalogue;

beforeEach(() => {
  store = new InMemoryRbacCatalogue();
  _setRbacCatalogue(store);
  // Most tests here exercise the full catalogue (built-in + custom); the
  // built-in-only filtering is covered on its own below.
  config.RBAC_CUSTOM_ROLES_ENABLED = true;
});

afterEach(() => {
  stopRbacRefresh();
  _setRbacRuntime(null);
  _setRbacCatalogue(null);
  process.env.CONFIG_ROOT = savedRoot;
  config.RBAC_CUSTOM_ROLES_ENABLED = savedCustomRoles;
  vi.useRealTimers();
});

const viewer = buildRole({ key: 'viewer', permissions: ['profiles.view'] });
const roleKeys = () => [...getRbacRuntime()!.roles.byKey.keys()].sort();

describe('rbacConfigCandidates', () => {
  it('lists brand, network and root, most specific first', () => {
    expect(
      rbacConfigCandidates({
        CONFIG_ROOT: '/c',
        AGGREGATOR_NETWORK: 'purple_dot',
        AGGREGATOR_BRAND: 'upsdm',
      }),
    ).toEqual(['/c/purple_dot/upsdm/rbac.yaml', '/c/purple_dot/rbac.yaml', '/c/rbac.yaml']);
  });

  it('drops the duplicate when there is no brand', () => {
    expect(rbacConfigCandidates({ CONFIG_ROOT: '/c', AGGREGATOR_NETWORK: 'blue_dot' })).toEqual([
      '/c/blue_dot/rbac.yaml',
      '/c/rbac.yaml',
    ]);
  });
});

describe('initRbac', () => {
  it('loads nothing when off', async () => {
    await initRbac('off');
    expect(getRbacRuntime()).toBeNull();
    expect(store.syncs).toEqual([]);
  });

  it('syncs the permissions and built-in roles, then loads them', async () => {
    await initRbac('enforce', 0);
    expect(store.syncs).toHaveLength(1);
    expect(store.syncs[0]).toMatch(/rbac\.yaml$/);
    expect(store.permissions).toHaveLength(15);
    expect(store.permissions.find((p) => p.key === 'profiles.view_pii')).toMatchObject({
      resource: 'profiles',
      action: 'view_pii',
      sensitive: true,
    });
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

  it('keeps custom roles across a sync', async () => {
    await initRbac('log', 0);
    store.setRoles([...store.storedRoles(), viewer]);
    await initRbac('log', 0);
    expect(roleKeys()).toContain('viewer');
  });

  it('fails boot when no rbac.yaml exists', async () => {
    process.env.CONFIG_ROOT = mkdtempSync(join(tmpdir(), 'rbac-root-'));
    await expect(initRbac('enforce', 0)).rejects.toMatchObject({ code: 'RBAC_CONFIG_NOT_FOUND' });
  });

  it('fails boot when the store is down', async () => {
    store.failWith({ code: 'DB_UNAVAILABLE', message: 'down' });
    await expect(initRbac('log', 0)).rejects.toMatchObject({ code: 'RBAC_CATALOGUE_UNAVAILABLE' });
  });

  it('fails boot when a stored custom role breaks a rule', async () => {
    await initRbac('log', 0);
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

describe('CUSTOM-ROLES flag gates the snapshot', () => {
  it('loads built-in roles only when the flag is off', async () => {
    config.RBAC_CUSTOM_ROLES_ENABLED = false;
    await initRbac('log', 0);
    const builtins = roleKeys();
    expect(builtins).not.toContain('viewer');
    // A stored custom role is dropped on load, so a refresh never adds it.
    store.setRoles([...store.storedRoles(), viewer]);
    expect(await refreshRbacCatalogue()).toBe('reloaded');
    expect(roleKeys()).toEqual(builtins);
    expect(roleKeys()).not.toContain('viewer');
  });

  it('includes custom roles when the flag is on', async () => {
    // beforeEach sets the flag on.
    store.setRoles([...store.storedRoles(), viewer]);
    await initRbac('log', 0);
    expect(roleKeys()).toContain('viewer');
  });
});
