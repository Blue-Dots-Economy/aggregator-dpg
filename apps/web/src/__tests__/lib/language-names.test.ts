/**
 * Tests for `language-names.ts` — language codes shown as names.
 */
import { describe, it, expect } from 'vitest';
import { languageName, languageNames } from '@/lib/language-names';

describe('languageName', () => {
  it('writes a code as a name in the given locale', () => {
    expect(languageName('hi', 'en')).toBe('Hindi');
    expect(languageName('en', 'en')).toBe('English');
  });

  it('writes the name in the page language', () => {
    expect(languageName('en', 'hi')).not.toBe('English');
  });

  it('falls back to the raw code when the code is malformed', () => {
    expect(languageName('not a code!', 'en')).toBe('not a code!');
  });
});

describe('languageNames', () => {
  it('joins names with a comma', () => {
    expect(languageNames(['hi', 'en', 'kn'], 'en')).toBe('Hindi, English, Kannada');
  });
});
