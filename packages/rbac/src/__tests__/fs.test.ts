import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRbacConfig } from '../fs/index.js';

const shipped = readFileSync(
  fileURLToPath(new URL('../../../../config/rbac.yaml', import.meta.url)),
  'utf8',
);

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'rbac-'));
}

describe('loadRbacConfig', () => {
  it('loads the first candidate that exists', async () => {
    const d = dir();
    const network = join(d, 'network.yaml');
    writeFileSync(network, shipped);
    const res = await loadRbacConfig([join(d, 'brand.yaml'), network, join(d, 'root.yaml')]);
    expect(res.path).toBe(network);
    expect(res.config.version).toBe(1);
  });

  it('throws RBAC_CONFIG_NOT_FOUND when nothing exists', async () => {
    await expect(loadRbacConfig([join(dir(), 'none.yaml')])).rejects.toMatchObject({
      code: 'RBAC_CONFIG_NOT_FOUND',
    });
  });

  it('throws RBAC_CONFIG_NOT_FOUND for an empty candidate list', async () => {
    await expect(loadRbacConfig([])).rejects.toMatchObject({ code: 'RBAC_CONFIG_NOT_FOUND' });
  });

  it('throws RBAC_CONFIG_READ_ERROR for broken YAML', async () => {
    const p = join(dir(), 'rbac.yaml');
    writeFileSync(p, 'roles: [unclosed');
    await expect(loadRbacConfig([p])).rejects.toMatchObject({ code: 'RBAC_CONFIG_READ_ERROR' });
  });

  it('throws RBAC_CONFIG_INVALID for a valid YAML of the wrong shape', async () => {
    const p = join(dir(), 'rbac.yaml');
    writeFileSync(p, 'version: 1\n');
    await expect(loadRbacConfig([p])).rejects.toMatchObject({ code: 'RBAC_CONFIG_INVALID' });
  });
});
