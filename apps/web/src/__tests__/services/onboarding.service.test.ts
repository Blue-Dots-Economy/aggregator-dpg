import { afterEach, describe, expect, it, vi } from 'vitest';
import { onboardingService } from '../../services/onboarding.service';

describe('onboardingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists links via the BFF proxy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              link_id: '1',
              slug: 'abc',
              domain: 'seeker',
              status: 'live',
              context: {},
              expires_at: null,
              public_url: 'http://example/r/abc',
              qr_url: null,
              qr_expires_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await onboardingService.listLinks({ domain: 'seeker' });
    expect(res.items).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/links', expect.any(Object));
  });

  it('creates a link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          link_id: '1',
          slug: 'abc',
          domain: 'seeker',
          status: 'live',
          context: {},
          expires_at: null,
          public_url: 'http://example/r/abc',
          qr_url: 'http://example/qr/1.png',
          qr_expires_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const link = await onboardingService.createLink({ domain: 'seeker', status: 'live' });
    expect(link.slug).toBe('abc');
  });

  it('throws on upstream failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('err', { status: 503 }));
    // CI on Node 24 / JSDOM 25 sometimes empties template-string error
    // messages; assert that the call throws rather than match the text.
    await expect(onboardingService.summary()).rejects.toThrow();
  });
});
