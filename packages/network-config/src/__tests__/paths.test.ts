import { describe, it, expect } from 'vitest';
import { resolveConfigDir, resolveConfigPath, resolveSchemaRoot } from '../paths.js';

describe('resolveConfigDir', () => {
  it('uses defaults when no env vars are set', () => {
    expect(resolveConfigDir({})).toBe('/app/config/blue_dot');
  });

  it('applies a custom AGGREGATOR_NETWORK', () => {
    expect(resolveConfigDir({ AGGREGATOR_NETWORK: 'orange_dot' })).toBe('/app/config/orange_dot');
  });

  it('appends brand when AGGREGATOR_BRAND is set', () => {
    expect(resolveConfigDir({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: 'upsdm' })).toBe(
      '/app/config/blue_dot/upsdm',
    );
  });

  it('treats empty AGGREGATOR_BRAND as absent (no brand suffix)', () => {
    expect(resolveConfigDir({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: '' })).toBe(
      '/app/config/blue_dot',
    );
  });

  it('treats whitespace-only AGGREGATOR_BRAND as absent', () => {
    expect(resolveConfigDir({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: '   ' })).toBe(
      '/app/config/blue_dot',
    );
  });

  it('respects a custom CONFIG_ROOT', () => {
    expect(resolveConfigDir({ CONFIG_ROOT: '/data/config', AGGREGATOR_NETWORK: 'blue_dot' })).toBe(
      '/data/config/blue_dot',
    );
  });

  it('respects CONFIG_ROOT + AGGREGATOR_BRAND together', () => {
    expect(
      resolveConfigDir({
        CONFIG_ROOT: '/mnt/cfg',
        AGGREGATOR_NETWORK: 'blue_dot',
        AGGREGATOR_BRAND: 'upsdm',
      }),
    ).toBe('/mnt/cfg/blue_dot/upsdm');
  });
});

describe('resolveConfigPath', () => {
  it('derives path from defaults when no env vars are set', () => {
    expect(resolveConfigPath({})).toBe('/app/config/blue_dot/aggregator.config.yaml');
  });

  it('derives path for network + brand', () => {
    expect(resolveConfigPath({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: 'upsdm' })).toBe(
      '/app/config/blue_dot/upsdm/aggregator.config.yaml',
    );
  });

  it('returns explicit AGGREGATOR_CONFIG_PATH override unchanged', () => {
    expect(
      resolveConfigPath({
        AGGREGATOR_CONFIG_PATH: '/custom/path/aggregator.config.yaml',
        AGGREGATOR_NETWORK: 'blue_dot',
        AGGREGATOR_BRAND: 'upsdm',
      }),
    ).toBe('/custom/path/aggregator.config.yaml');
  });

  it('ignores whitespace-only AGGREGATOR_CONFIG_PATH (falls through to derivation)', () => {
    expect(
      resolveConfigPath({ AGGREGATOR_CONFIG_PATH: '  ', AGGREGATOR_NETWORK: 'orange_dot' }),
    ).toBe('/app/config/orange_dot/aggregator.config.yaml');
  });
});

describe('resolveSchemaRoot', () => {
  it('derives schema root from defaults when no env vars are set', () => {
    expect(resolveSchemaRoot({})).toBe('/app/config/blue_dot/schemas');
  });

  it('derives schema root for network + brand', () => {
    expect(resolveSchemaRoot({ AGGREGATOR_NETWORK: 'blue_dot', AGGREGATOR_BRAND: 'upsdm' })).toBe(
      '/app/config/blue_dot/upsdm/schemas',
    );
  });

  it('returns explicit SCHEMA_ROOT_DIR override unchanged', () => {
    expect(
      resolveSchemaRoot({
        SCHEMA_ROOT_DIR: '/opt/schemas',
        AGGREGATOR_NETWORK: 'blue_dot',
        AGGREGATOR_BRAND: 'upsdm',
      }),
    ).toBe('/opt/schemas');
  });

  it('ignores whitespace-only SCHEMA_ROOT_DIR (falls through to derivation)', () => {
    expect(resolveSchemaRoot({ SCHEMA_ROOT_DIR: '  ', AGGREGATOR_NETWORK: 'orange_dot' })).toBe(
      '/app/config/orange_dot/schemas',
    );
  });

  it('respects a custom CONFIG_ROOT', () => {
    expect(resolveSchemaRoot({ CONFIG_ROOT: '/data/config', AGGREGATOR_NETWORK: 'blue_dot' })).toBe(
      '/data/config/blue_dot/schemas',
    );
  });
});
