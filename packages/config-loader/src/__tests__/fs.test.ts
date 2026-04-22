import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FsConfigService } from '../fs/index.js';

/**
 * Builds a minimal repo root with a packages/ directory and optional env YAML.
 */
function makeRepo(
  root: string,
  opts: {
    envYaml?: string;
    env?: string;
    packages?: Array<{
      name: string;
      configKey: string;
      configDefaults?: Record<string, unknown>;
    }>;
  } = {},
): void {
  const packagesDir = join(root, 'packages');
  mkdirSync(packagesDir, { recursive: true });

  const envDir = join(root, 'config', 'env');
  mkdirSync(envDir, { recursive: true });

  if (opts.envYaml !== undefined) {
    const envName = opts.env ?? 'test';
    writeFileSync(join(envDir, `${envName}.yaml`), opts.envYaml, 'utf8');
  }

  for (const pkg of opts.packages ?? []) {
    const pkgDir = join(packagesDir, pkg.name);
    const distDir = join(pkgDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: `@test/${pkg.name}` }),
      'utf8',
    );

    const defaultsLine =
      pkg.configDefaults !== undefined
        ? `export const configDefaults = ${JSON.stringify(pkg.configDefaults)};`
        : '';

    writeFileSync(
      join(distDir, 'config.schema.js'),
      [
        `export const configKey = ${JSON.stringify(pkg.configKey)};`,
        `export const configSchema = { parse: () => ({}) };`,
        defaultsLine,
      ].join('\n'),
      'utf8',
    );
  }
}

describe('FsConfigService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `fs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads env YAML into the store', async () => {
    makeRepo(tmpDir, { envYaml: 'db:\n  host: prod-db\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('db.host')).toBe('prod-db');
  });

  it('seeds per-package defaults before env YAML', async () => {
    makeRepo(tmpDir, {
      packages: [
        {
          name: 'pkg-a',
          configKey: 'pkgA',
          configDefaults: { timeout: 5000, url: 'http://default' },
        },
      ],
      envYaml: 'pkgA:\n  url: http://override\n',
      env: 'test',
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    // Env YAML overrides url but default timeout survives
    expect(svc.get('pkgA.url')).toBe('http://override');
    expect(svc.get('pkgA.timeout')).toBe(5000);
  });

  it('uses only defaults when no env YAML exists', async () => {
    makeRepo(tmpDir, {
      packages: [{ name: 'pkg-a', configKey: 'pkgA', configDefaults: { port: 8080 } }],
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('pkgA.port')).toBe(8080);
  });

  it('deep-merges nested defaults with nested env overrides', async () => {
    makeRepo(tmpDir, {
      packages: [
        {
          name: 'pkg-a',
          configKey: 'pkgA',
          configDefaults: { db: { host: 'localhost', port: 5432 } },
        },
      ],
      envYaml: 'pkgA:\n  db:\n    port: 5433\n',
      env: 'test',
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('pkgA.db.host')).toBe('localhost');
    expect(svc.get('pkgA.db.port')).toBe(5433);
  });

  it('get returns undefined for missing path', async () => {
    makeRepo(tmpDir);
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('nonexistent')).toBeUndefined();
  });

  it('require throws CONFIG_KEY_MISSING for absent path', async () => {
    makeRepo(tmpDir);
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(() => svc.require('missing')).toThrow('missing');
  });

  it('reload restores previous store on failure', async () => {
    makeRepo(tmpDir, { envYaml: 'key: value\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.get('key')).toBe('value');

    // Remove the env file to force reload failure
    rmSync(join(tmpDir, 'config', 'env', 'test.yaml'));
    // Create an invalid YAML to cause a parse error
    writeFileSync(join(tmpDir, 'config', 'env', 'test.yaml'), ': invalid: yaml: [', 'utf8');

    await expect(svc.reload()).rejects.toThrow();
    // Store preserved from before reload
    expect(svc.get('key')).toBe('value');
  });

  it('reload notifies onChange listeners on success', async () => {
    makeRepo(tmpDir, { envYaml: 'x: 1\n', env: 'test' });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');

    let notified = false;
    svc.onChange(() => {
      notified = true;
    });
    await svc.reload();
    expect(notified).toBe(true);
  });

  it('getRegistry returns discovered packages after load', async () => {
    makeRepo(tmpDir, {
      packages: [{ name: 'pkg-a', configKey: 'pkgA' }],
    });
    const svc = new FsConfigService(tmpDir);
    await svc.load('test');
    expect(svc.getRegistry().has('pkgA')).toBe(true);
  });
});
