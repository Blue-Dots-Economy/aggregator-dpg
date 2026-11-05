/**
 * Root layout `generateMetadata`: page title and description from the
 * aggregator config, with the translated fallback when the config is missing
 * or has the wrong shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `t:${key}`),
  getLocale: vi.fn(),
  getMessages: vi.fn(),
}));

import { generateMetadata } from '@/app/layout';

function mockConfig(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

describe('generateMetadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the brand long name and tagline', async () => {
    mockConfig({ brand: { long_name: 'Blue Dots Portal', tagline: 'Every participant' } });
    const meta = await generateMetadata();
    expect(meta.title).toBe('Blue Dots Portal');
    expect(meta.description).toBe('Every participant');
  });

  it('builds a description from the long name when there is no tagline', async () => {
    mockConfig({ brand: { long_name: 'Blue Dots Portal' } });
    const meta = await generateMetadata();
    expect(meta.description).toBe('Blue Dots Portal — track every participant in your network.');
  });

  it.each([
    ['no brand', {}],
    ['a numeric long name', { brand: { long_name: 42 } }],
    ['an empty long name', { brand: { long_name: '' } }],
    ['a numeric tagline', { brand: { long_name: 'Blue Dots Portal', tagline: 7 } }],
  ])('falls back to the translated title for %s', async (_label, body) => {
    mockConfig(body);
    const meta = await generateMetadata();
    expect(meta.title).toBe('t:title');
    expect(meta.description).toBe('t:description');
  });

  it('falls back to the translated title when the api fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    const meta = await generateMetadata();
    expect(meta.title).toBe('t:title');
  });
});
