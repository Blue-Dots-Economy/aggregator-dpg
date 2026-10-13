import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRbacFile } from '../fs/index.js';

const shipped = readFileSync(
  fileURLToPath(new URL('../../../../config/rbac.yaml', import.meta.url)),
  'utf8',
);

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'rbac-'));
}

describe('loadRbacFile', () => {
  it('loads the first candidate that exists', async () => {
    const d = dir();
    const network = join(d, 'network.yaml');
    writeFileSync(network, shipped);
    const res = await loadRbacFile([join(d, 'brand.yaml'), network, join(d, 'root.yaml')]);
    expect(res.path).toBe(network);
    expect(res.roles.map((r) => r.key)).toContain('coordinator');
  });

  it('throws RBAC_CONFIG_NOT_FOUND when nothing exists', async () => {
    await expect(loadRbacFile([join(dir(), 'none.yaml')])).rejects.toMatchObject({
      code: 'RBAC_CONFIG_NOT_FOUND',
    });
  });

  it('throws RBAC_CONFIG_NOT_FOUND for an empty candidate list', async () => {
    await expect(loadRbacFile([])).rejects.toMatchObject({ code: 'RBAC_CONFIG_NOT_FOUND' });
  });

  it('throws RBAC_CONFIG_READ_ERROR for broken YAML', async () => {
    const p = join(dir(), 'rbac.yaml');
    writeFileSync(p, 'roles: [unclosed');
    await expect(loadRbacFile([p])).rejects.toMatchObject({ code: 'RBAC_CONFIG_READ_ERROR' });
  });

  it('throws RBAC_CONFIG_INVALID for a valid YAML of the wrong shape', async () => {
    const p = join(dir(), 'rbac.yaml');
    writeFileSync(p, 'version: 1\n');
    await expect(loadRbacFile([p])).rejects.toMatchObject({ code: 'RBAC_CONFIG_INVALID' });
  });
});
