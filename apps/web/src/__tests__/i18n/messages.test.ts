import { describe, it, expect } from 'vitest';
import en from '@/i18n/messages/en.json';
import kn from '@/i18n/messages/kn.json';
import hi from '@/i18n/messages/hi.json';

/** Recursively collects dotted key paths from a nested message object. */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? keyPaths(v as Record<string, unknown>, path)
      : [path];
  });
}

describe('message catalogs', () => {
  const enKeys = keyPaths(en).sort((a, b) => a.localeCompare(b));

  it('en has at least the seed namespaces', () => {
    expect(enKeys).toContain('language.label');
    expect(enKeys).toContain('metadata.title');
  });

  it('kn has exactly the same keys as en', () => {
    expect(keyPaths(kn).sort((a, b) => a.localeCompare(b))).toEqual(enKeys);
  });

  it('hi has exactly the same keys as en', () => {
    expect(keyPaths(hi).sort((a, b) => a.localeCompare(b))).toEqual(enKeys);
  });

  // Call-back is deferred (#1123): the participant places the call, so no
  // locale may say they can request one.
  it.each([
    ['en', en.registration_mode.voice_or_form.hint, /request a call/i],
    ['hi', hi.registration_mode.voice_or_form.hint, /अनुरोध/],
    ['kn', kn.registration_mode.voice_or_form.hint, /ಕೋರ/],
  ])('%s voice_or_form hint does not promise a call-back', (_locale, hint, forbidden) => {
    expect(hint).not.toMatch(forbidden);
  });
});
