import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveEnv } from '../env.js';

describe('resolveEnv', () => {
  let originalConfigEnv: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalConfigEnv = process.env['CONFIG_ENV'];
    originalNodeEnv = process.env['NODE_ENV'];
    delete process.env['CONFIG_ENV'];
    delete process.env['NODE_ENV'];
  });

  afterEach(() => {
    if (originalConfigEnv !== undefined) {
      process.env['CONFIG_ENV'] = originalConfigEnv;
    } else {
      delete process.env['CONFIG_ENV'];
    }
    if (originalNodeEnv !== undefined) {
      process.env['NODE_ENV'] = originalNodeEnv;
    } else {
      delete process.env['NODE_ENV'];
    }
  });

  it('returns development when neither CONFIG_ENV nor NODE_ENV is set', () => {
    expect(resolveEnv()).toBe('development');
  });

  it('uses NODE_ENV when CONFIG_ENV is absent', () => {
    process.env['NODE_ENV'] = 'production';
    expect(resolveEnv()).toBe('production');
  });

  it('prefers CONFIG_ENV over NODE_ENV', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['CONFIG_ENV'] = 'staging';
    expect(resolveEnv()).toBe('staging');
  });

  it('returns test when CONFIG_ENV is test', () => {
    process.env['CONFIG_ENV'] = 'test';
    expect(resolveEnv()).toBe('test');
  });

  it('throws when value is not a valid Env', () => {
    process.env['CONFIG_ENV'] = 'unknown-env';
    expect(() => resolveEnv()).toThrow(/Invalid environment "unknown-env"/);
  });

  it('throws when NODE_ENV is invalid and CONFIG_ENV absent', () => {
    process.env['NODE_ENV'] = 'local';
    expect(() => resolveEnv()).toThrow(/Invalid environment "local"/);
  });
});
