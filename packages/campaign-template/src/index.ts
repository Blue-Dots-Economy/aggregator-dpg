/**
 * Campaign email templating — placeholder utilities (aggregator-dpg#578).
 *
 * Pure, dependency-free helpers shared by the API (which validates the template
 * at submit time) and the worker (which substitutes per-recipient values). The
 * Markdown render + sanitise lives in the sibling `./render` subpath so callers
 * that only validate never load the Markdown dependencies. Belongs to
 * `@aggregator-dpg/campaign-template`.
 */

/** The fixed set of supported `{{token}}` placeholders (v1). */
export const SUPPORTED_PLACEHOLDERS = [
  'name',
  'first_name',
  'last_name',
  'email',
  'phone',
] as const;

export type Placeholder = (typeof SUPPORTED_PLACEHOLDERS)[number];

/** Canonical contact fields resolvable from the participant store. */
export type ContactField = 'name' | 'email' | 'phone';

/** Per-recipient placeholder values; a missing value renders as an empty string. */
export type PlaceholderValues = Partial<Record<Placeholder, string | null>>;

// Matches `{{token}}` with optional surrounding whitespace; token is ASCII
// letters/underscore. Global so `matchAll`/`replace` cover every occurrence.
const TOKEN_RE = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

/**
 * Extracts the distinct placeholder tokens referenced across the given texts.
 *
 * @param texts - Subject and/or body strings to scan.
 * @returns The distinct lower-cased token names found (supported or not).
 */
export function extractPlaceholders(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(TOKEN_RE)) {
      found.add(match[1]!.toLowerCase());
    }
  }
  return [...found];
}

/**
 * Returns the referenced tokens that are NOT in the supported set. The API
 * rejects a request (400) when this is non-empty, so a typo never ships.
 *
 * @param texts - Subject and/or body strings to scan.
 * @returns The unsupported token names (empty when everything is valid).
 */
export function unknownPlaceholders(...texts: string[]): string[] {
  const supported = new Set<string>(SUPPORTED_PLACEHOLDERS);
  return extractPlaceholders(...texts).filter((token) => !supported.has(token));
}

/**
 * Maps the placeholders actually used to the contact fields needed to resolve
 * them, so the worker decrypts the minimum. `name`/`first_name`/`last_name` all
 * need `name`; `email`/`phone` map to themselves.
 *
 * @param texts - Subject and/or body strings to scan.
 * @returns The distinct contact fields the placeholders require (may be empty).
 */
export function requiredContactFields(...texts: string[]): ContactField[] {
  const used = new Set(extractPlaceholders(...texts));
  const needed = new Set<ContactField>();
  if (used.has('name') || used.has('first_name') || used.has('last_name')) needed.add('name');
  if (used.has('email')) needed.add('email');
  if (used.has('phone')) needed.add('phone');
  return [...needed];
}

/**
 * Builds the full placeholder value map for one recipient from the resolved
 * contact fields. `first_name` is the first whitespace-delimited word of the
 * name; `last_name` is the remainder.
 *
 * @param contact - Resolved name/email/phone (any may be null/absent).
 * @returns The value map for every supported placeholder.
 */
export function placeholderValues(contact: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}): PlaceholderValues {
  const name = contact.name?.trim() ?? '';
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    name,
    first_name: parts[0] ?? '',
    last_name: parts.slice(1).join(' '),
    email: contact.email ?? '',
    phone: contact.phone ?? '',
  };
}

/**
 * Substitutes supported `{{token}}` placeholders in a string. Unknown tokens
 * are left verbatim (the API rejects them before this runs); a missing value
 * renders as an empty string.
 *
 * @param text - The template string.
 * @param values - Per-recipient placeholder values.
 * @param escape - Optional value transform applied before insertion (e.g. HTML-escape).
 * @returns The substituted string.
 */
export function substitute(
  text: string,
  values: PlaceholderValues,
  escape?: (value: string) => string,
): string {
  const supported = new Set<string>(SUPPORTED_PLACEHOLDERS);
  return text.replace(TOKEN_RE, (whole, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (!supported.has(key)) return whole;
    const value = values[key as Placeholder] ?? '';
    return escape ? escape(value) : value;
  });
}

/** Escapes the five HTML metacharacters so a substituted value can't inject markup. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
