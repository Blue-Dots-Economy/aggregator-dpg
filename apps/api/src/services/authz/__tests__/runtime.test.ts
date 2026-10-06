/**
 * Unit tests for RBAC boot-time init (`@aggregator-dpg/api`, R0).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRbacRuntime, initRbac, rbacConfigCandidates, _setRbacRuntime } from '../runtime.js';

const savedRoot = process.env.CONFIG_ROOT;

afterEach(() => {
  _setRbacRuntime(null);
  process.env.CONFIG_ROOT = savedRoot;
});

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
  });

  it('loads the shipped rbac.yaml in log mode', async () => {
    await initRbac('log');
    expect(getRbacRuntime()).toMatchObject({ mode: 'log', config: { version: 1 } });
  });

  it('fails boot when no rbac.yaml exists', async () => {
    process.env.CONFIG_ROOT = mkdtempSync(join(tmpdir(), 'rbac-root-'));
    await expect(initRbac('enforce')).rejects.toMatchObject({ code: 'RBAC_CONFIG_NOT_FOUND' });
  });
});
