import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkDomains, servedDomains } from '@/lib/console-domains.server';

const domains = [
  { id: 'seeker', label: 'Seekers' },
  { id: 'service_provider', label: 'Service providers' },
];

describe('servedDomains', () => {
  it('returns every configured domain for an empty list', () => {
    expect(servedDomains([], domains)).toEqual(domains);
  });

  it('labels the served ids and keeps an unknown id as its own label', () => {
    expect(servedDomains(['service_provider', 'tutor'], domains)).toEqual([
      { id: 'service_provider', label: 'Service providers' },
      { id: 'tutor', label: 'tutor' },
    ]);
  });
});

describe('networkDomains', () => {
  function mockConfig(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the configured ids and labels', async () => {
    mockConfig({ domains: [{ id: 'seeker', label: 'Seekers', plural_label: 'Seekers' }] });
    await expect(networkDomains()).resolves.toEqual([{ id: 'seeker', label: 'Seekers' }]);
  });

  it('uses the id as the label when a domain has none', async () => {
    mockConfig({ domains: [{ id: 'seeker' }] });
    await expect(networkDomains()).resolves.toEqual([{ id: 'seeker', label: 'seeker' }]);
  });

  it.each([
    ['a domain with no id', { domains: [{ label: 'Seekers' }] }],
    ['domains as text', { domains: 'seeker' }],
    ['a JSON array', [{ id: 'seeker' }]],
  ])('returns no domains for %s', async (_label, body) => {
    mockConfig(body);
    await expect(networkDomains()).resolves.toEqual([]);
  });

  it('returns no domains when the api fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    );
    await expect(networkDomains()).resolves.toEqual([]);
  });
});
