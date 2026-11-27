/**
 * Unit tests for the instance-upgrade pool settings (`@aggregator-dpg/api`).
 *
 * Reads the options the tool builds its pool from; no connection is opened.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upgradePoolConfig } from '../instance-upgrade.js';

describe('upgradePoolConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets the network and brand on every new connection through onConnect', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u@db.invalid/app');
    vi.stubEnv('AGGREGATOR_NETWORK', 'blue_dot');
    vi.stubEnv('AGGREGATOR_BRAND', 'up-gzb');
    const config = upgradePoolConfig();
    expect(config.connectionString).toBe('postgres://u@db.invalid/app');

    const calls: unknown[][] = [];
    await config.onConnect({
      query: async (text: string, values?: unknown[]) => {
        calls.push([text, values]);
        return { rows: [] };
      },
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("set_config('aggregator_dpg.network', $1, false)");
    expect(calls[0]?.[1]).toEqual(['blue_dot', 'up-gzb']);
  });

  it('passes empty settings when the network and brand are unset', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u@db.invalid/app');
    vi.stubEnv('AGGREGATOR_NETWORK', '');
    vi.stubEnv('AGGREGATOR_BRAND', '');
    const values: unknown[] = [];
    await upgradePoolConfig().onConnect({
      query: async (_text: string, v?: unknown[]) => {
        values.push(v);
        return { rows: [] };
      },
    });
    expect(values).toEqual([['', '']]);
  });

  it('refuses when DATABASE_URL is unset', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => upgradePoolConfig()).toThrow(/DATABASE_URL/);
  });
});
