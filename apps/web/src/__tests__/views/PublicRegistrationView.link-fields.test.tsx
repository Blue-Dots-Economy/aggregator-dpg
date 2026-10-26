/**
 * Link fields on the public form are checked by the server, not the browser.
 *
 * The network-config loader gives every link field Signals' URL pattern
 * (#904). The public form only shows field errors after a submit attempt,
 * while an invalid field keeps Submit disabled (#903) — so a browser-side
 * URL check would leave a participant who typed `NA` with a dead button and
 * no reason. Until #903 lands, the browser skips that pattern and the API's
 * 400 names the field in the banner instead.
 */
import { describe, it, expect } from 'vitest';
import { dropBrowserLinkPattern } from '@/app/[org]/[slug]/PublicRegistrationView';

describe('dropBrowserLinkPattern', () => {
  it('removes the URL pattern from a link field and keeps everything else', () => {
    const def: Record<string, unknown> = {
      type: 'string',
      title: 'Website',
      'x-uri': true,
      pattern: '^x$',
      maxLength: 2048,
    };
    dropBrowserLinkPattern(def);
    expect(def).toEqual({ type: 'string', title: 'Website', 'x-uri': true, maxLength: 2048 });
  });

  it('removes it from the items of a list of links', () => {
    const def: Record<string, unknown> = {
      type: 'array',
      'x-uri': true,
      items: { type: 'string', pattern: '^x$' },
    };
    dropBrowserLinkPattern(def);
    expect(def['items']).toEqual({ type: 'string' });
  });

  it('leaves the pattern on any other field', () => {
    const def: Record<string, unknown> = { type: 'string', pattern: '^[0-9]{10}$' };
    dropBrowserLinkPattern(def);
    expect(def['pattern']).toBe('^[0-9]{10}$');
  });
});
