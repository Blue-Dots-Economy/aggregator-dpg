/**
 * Slug generation utilities.
 *
 * `slugify` produces a URL-safe, lower-case, hyphen-separated rendering of
 * arbitrary input. `randomSuffix` appends a short hex suffix so multiple
 * registrations from the same display `name` don't collide on the unique
 * `org_slug` column. The slug is generated **once** at INSERT time from
 * `aggregator.name` and is then immutable — the DB trigger
 * `aggregators_lock_slug` rejects any UPDATE that mutates the column,
 * even if `name` is later edited.
 */

import { randomBytes } from 'node:crypto';

const MAX_SLUG_LEN = 60;

/**
 * Converts a free-form string into a URL-safe slug.
 *
 * Falls back to "org" when input contains no slug-friendly characters
 * (e.g. only emoji or punctuation) so callers always get a non-empty stem.
 *
 * @param input - Raw input (aggregator display name).
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
 * Composes a slug from the aggregator's display name + a random suffix:
 * `slugify(name)-<hex>`. Call this once at INSERT — the slug is immutable
 * afterwards (DB trigger `aggregators_lock_slug` enforces it).
 *
 * @param name - Aggregator display name from the registration payload.
 * @param bytes - Random suffix length in bytes (default 2 → 4 hex chars).
 */
export function slugFromName(name: string, bytes = 2): string {
  return `${slugify(name)}-${randomSuffix(bytes)}`;
}

/**
 * Legacy alias for {@link slugFromName}. Kept so callers that still pass an
 * association string don't break until Phase 6 swaps them to `name`.
 *
 * @deprecated Use {@link slugFromName} once the registration route is on the new payload.
 */
export function slugWithSuffix(stem: string, bytes = 2): string {
  return slugFromName(stem, bytes);
}
