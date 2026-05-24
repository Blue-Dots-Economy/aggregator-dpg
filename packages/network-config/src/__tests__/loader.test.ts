import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileNetworkConfigLoader } from '../loader.js';

const BLUE_DOT_YAML = `
aggregator:
  name: BBMP
  network:
    source: https://example.invalid/blue_dot/network.json
  brand:
    short_name: Blue Dots
    long_name: Blue Dots Aggregator Portal
    url_slug: blue-dots
`;

const BLUE_DOT_NETWORK = {
  id: 'blue_dot',
  display_name: 'Blue Dot',
  domains: [
    {
      id: 'seeker',
      item_schemas: {
        'profile_1.0': {
          properties: {
            name: { type: 'string' },
            phone: { type: 'string', format: 'tel' },
            email: { type: 'string', format: 'email' },
          },
        },
      },
    },
    {
      id: 'provider',
      item_schemas: {
        'job_posting_1.0': {
          properties: {
            jobProviderName: { type: 'string' },
            hiringManagerPhoneNumber: { type: 'string', format: 'tel' },
            hiringManagerEmail: { type: 'string', format: 'email' },
          },
        },
      },
    },
  ],
};

describe('FileNetworkConfigLoader', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agg-cfg-'));
    configPath = path.join(tmpDir, 'aggregator.config.yaml');
    await fs.writeFile(configPath, BLUE_DOT_YAML, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves both blue_dot domains with sniffed identity selectors', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () =>
        new Response(JSON.stringify(BLUE_DOT_NETWORK), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const result = await loader.load();
    expect(result.success).toBe(true);
    if (!result.success) return;
    const resolved = result.value;
    expect(resolved.network.id).toBe('blue_dot');
    expect(resolved.domainIds).toEqual(['seeker', 'provider']);
    expect(resolved.domains['seeker']?.itemType).toBe('profile_1.0');
    expect(resolved.domains['seeker']?.identity).toEqual({
      name: 'name',
      phone: 'phone',
      email: 'email',
    });
    expect(resolved.domains['provider']?.itemType).toBe('job_posting_1.0');
    expect(resolved.domains['provider']?.identity).toEqual({
      name: 'jobProviderName',
      phone: 'hiringManagerPhoneNumber',
      email: 'hiringManagerEmail',
    });
  });

  it('returns CONFIG_FILE_MISSING when the YAML is absent', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath: path.join(tmpDir, 'missing.yaml'),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('CONFIG_FILE_MISSING');
  });

  it('falls back to cached network.json on upstream failure', async () => {
    const cacheDir = path.join(tmpDir, 'cache');
    let calls = 0;
    const fetchOk: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
    };
    const fetchFail: typeof fetch = async () => {
      calls += 1;
      return new Response('upstream down', { status: 503 });
    };
    // First boot — fetches + writes cache.
    const first = new FileNetworkConfigLoader({ configPath, cacheDir, fetchImpl: fetchOk });
    const r1 = await first.load();
    expect(r1.success).toBe(true);
    // Second boot — upstream is down; cache rescues us.
    const second = new FileNetworkConfigLoader({ configPath, cacheDir, fetchImpl: fetchFail });
    const r2 = await second.load();
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.value.network.id).toBe('blue_dot');
    expect(calls).toBe(2);
  });

  it('caches the resolved config — second load() returns the same singleton', async () => {
    let calls = 0;
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(BLUE_DOT_NETWORK), { status: 200 });
      },
    });
    const r1 = await loader.load();
    const r2 = await loader.load();
    expect(r1.success && r2.success).toBe(true);
    if (r1.success && r2.success) expect(r1.value).toBe(r2.value);
    expect(calls).toBe(1);
  });

  it('rejects a network.json missing required fields', async () => {
    const loader = new FileNetworkConfigLoader({
      configPath,
      fetchImpl: async () => new Response(JSON.stringify({ domains: [] }), { status: 200 }),
    });
    const result = await loader.load();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.error as { code: string }).code).toBe('NETWORK_FETCH_FAILED');
  });
});
