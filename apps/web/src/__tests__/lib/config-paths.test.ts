import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { resolveSchemaRoot } from '@/lib/config-paths';

const ENV_KEYS = ['SCHEMA_ROOT_DIR', 'CONFIG_ROOT', 'AGGREGATOR_NETWORK', 'AGGREGATOR_BRAND'];

describe('resolveSchemaRoot', () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('honours an explicit SCHEMA_ROOT_DIR', () => {
    process.env.SCHEMA_ROOT_DIR = '/custom/schemas';
    expect(resolveSchemaRoot()).toBe('/custom/schemas');
  });

  it('trims whitespace on SCHEMA_ROOT_DIR', () => {
    process.env.SCHEMA_ROOT_DIR = '  /custom/schemas  ';
    expect(resolveSchemaRoot()).toBe('/custom/schemas');
  });

  it('treats an empty/whitespace SCHEMA_ROOT_DIR as unset', () => {
    process.env.SCHEMA_ROOT_DIR = '   ';
    process.env.CONFIG_ROOT = '/app/config';
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'schemas'));
  });

  it('derives from CONFIG_ROOT + AGGREGATOR_NETWORK when brand is unset', () => {
    process.env.CONFIG_ROOT = '/app/config';
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'schemas'));
  });

  it('appends AGGREGATOR_BRAND when set', () => {
    process.env.CONFIG_ROOT = '/app/config';
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    process.env.AGGREGATOR_BRAND = 'upsdm';
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'upsdm', 'schemas'));
  });

  it('treats an empty/whitespace AGGREGATOR_BRAND as absent', () => {
    process.env.CONFIG_ROOT = '/app/config';
    process.env.AGGREGATOR_NETWORK = 'blue_dot';
    process.env.AGGREGATOR_BRAND = '   ';
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'schemas'));
  });

  it('falls back to defaults when CONFIG_ROOT/AGGREGATOR_NETWORK are unset', () => {
    expect(resolveSchemaRoot()).toBe(path.join('/app/config', 'blue_dot', 'schemas'));
  });
});
