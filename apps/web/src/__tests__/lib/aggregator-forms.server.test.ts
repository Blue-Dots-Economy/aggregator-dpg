/**
 * `loadPublishedForm` — the published-bundle side of aggregator-dpg#640.
 *
 * Every failure mode must return null rather than throw, because the caller's
 * fallback to the on-disk schema is what lets `forms_source` roll out one
 * deployment at a time. A throw here is a blank registration page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadPublishedForm } from '@/lib/aggregator-forms.server';

const origFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('loadPublishedForm', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns the requested form from the bundle', async () => {
    globalThis.fetch = vi.fn(() =>
      json({ forms: { 'coordinator-registration': { title: 'Coordinator' } } }),
    ) as unknown as typeof fetch;

    await expect(loadPublishedForm('coordinator-registration')).resolves.toEqual({
      title: 'Coordinator',
    });
  });

  it('returns null when the bundle omits that form', async () => {
    // A bundle that does not serve this form is a normal state, not an error:
    // absence must fall back, never throw.
    globalThis.fetch = vi.fn(() => json({ forms: { profile: {} } })) as unknown as typeof fetch;
    await expect(loadPublishedForm('org-registration')).resolves.toBeNull();
  });

  it('returns null when no forms_source is configured (forms: null)', async () => {
    globalThis.fetch = vi.fn(() => json({ forms: null })) as unknown as typeof fetch;
    await expect(loadPublishedForm('profile')).resolves.toBeNull();
  });

  it('returns null on a non-2xx', async () => {
    globalThis.fetch = vi.fn(() => json({}, 503)) as unknown as typeof fetch;
    await expect(loadPublishedForm('profile')).resolves.toBeNull();
  });

  it('returns null on a transport failure rather than throwing', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    await expect(loadPublishedForm('profile')).resolves.toBeNull();
  });

  it('returns null on a body that is not JSON', async () => {
    // What a GitHub 404 page looks like by the time it reaches here.
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('<!doctype html>', { status: 200 })),
    ) as unknown as typeof fetch;
    await expect(loadPublishedForm('profile')).resolves.toBeNull();
  });
});
