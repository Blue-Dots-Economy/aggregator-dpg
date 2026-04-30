/**
 * Slug generation utilities.
 *
 * `slugify` produces a URL-safe, lower-case, hyphen-separated rendering of
 * arbitrary input. `randomSuffix` appends a short hex suffix so multiple
 * applications from the same association don't collide on the unique
 * `org_slug` column.
 */

import { randomBytes } from 'node:crypto';

const MAX_SLUG_LEN = 60;

/**
 * Converts a free-form string into a URL-safe slug.
 *
 * Falls back to "org" when input contains no slug-friendly characters
 * (e.g. only emoji or punctuation) so callers always get a non-empty stem.
 *
 * @param input - Raw input (association name, etc.).
 * @returns Lower-case slug, max 60 chars.
 */
export function slugify(input: string): string {
  const cleaned = (input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN);
  return cleaned || 'org';
}

/**
 * Returns a short hex suffix suitable for slug uniqueness.
 *
 * @param bytes - Number of random bytes (default 2 → 4 hex chars).
 * @returns Lower-case hex string.
 */
export function randomSuffix(bytes = 2): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Composes a slug stem with a random suffix: `<stem>-<hex>`.
 */
export function slugWithSuffix(stem: string, bytes = 2): string {
  return `${slugify(stem)}-${randomSuffix(bytes)}`;
}
