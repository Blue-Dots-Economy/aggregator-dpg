/**
 * `{{token}}` substitution for externalised email copy.
 *
 * Belongs to `@aggregator-dpg/api`. Substitution is TYPED, and that is the
 * whole point of this module: once copy lives in a file that a non-engineer
 * edits, the escaping decision can no longer sit at each call site. A `text`
 * token is HTML-escaped on substitution; an `html` token is inserted raw and
 * may only be produced in code from already-escaped parts. Without that split,
 * the first `{{orgName}}` someone types into a properties file is an injection
 * hole.
 *
 * Substitution is best-effort: an unprovided token is left as literal
 * `{{token}}` text rather than throwing or rendering an empty gap, so a copy
 * typo degrades to something visibly wrong instead of silently losing meaning.
 *
 * @module @aggregator-dpg/api
 */

import { escapeHtml } from './shared.js';

/**
 * The one `{{token}}` grammar, shared by the substituter and the boot-time
 * validator so the two cannot disagree about what a token looks like.
 */
export const TOKEN_RE = /\{\{(\w+)\}\}/g;

/** How a token's value must be treated on substitution. */
export type TokenType = 'text' | 'html';

/** Declared token types for one email case. */
export type TokenTypes = Readonly<Record<string, TokenType>>;

/**
 * Substitutes `{{token}}` placeholders in a copy fragment.
 *
 * @param template - Copy fragment from the properties file.
 * @param values - Token values; a missing or undefined value is left literal.
 * @param types - Declared type per token. An undeclared token is treated as
 *   `text` (escaped) — the safe default, so forgetting to declare one cannot
 *   introduce raw HTML.
 * @returns The fragment with tokens substituted.
 */
export function substitute(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
  types: TokenTypes = {},
): string {
  return template.replace(TOKEN_RE, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) return whole;
    return types[name] === 'html' ? value : escapeHtml(value);
  });
}

/**
 * Collects the token names used by a copy fragment.
 *
 * @param template - Copy fragment.
 * @returns Token names, deduplicated.
 */
export function tokensUsed(template: string): string[] {
  return [...new Set([...template.matchAll(TOKEN_RE)].map((m) => m[1] as string))];
}

/**
 * The copy files' entire tag vocabulary, as an explicit allow-list.
 *
 * The attribute run is bounded (`{0,200}`) and excludes `<`/`>` so the pattern
 * cannot backtrack super-linearly — a generic `<[^>]+>` is O(n^2) on
 * unterminated input.
 */
const ALLOWED_TAG_RE = /<\/?(?:b|strong|i|em|a|br)(?:\s[^<>]{0,200})?\/?>/gi;

/**
 * Converts a copy fragment to its plain-text equivalent.
 *
 * Externalised copy is authored once as an HTML fragment and the text part is
 * derived from it, so the two can never drift — a real defect class here
 * before (the HTML body and the text body were maintained separately and one
 * shipped a support line the other lacked).
 *
 * Only the tag vocabulary the copy files are allowed to use is recognised —
 * `<b> <strong> <i> <em> <a> <br>` — matched by an explicit allow-list rather
 * than a generic `<[^>]+>` strip. Two reasons: a catch-all backtracks
 * super-linearly on unterminated input (`<aaaa…` with no `>`), and a tag
 * outside the vocabulary should stay VISIBLE in the text part so copy using a
 * disallowed tag looks wrong instead of silently losing content.
 *
 * @param html - Copy fragment, already substituted.
 * @returns Plain-text rendering with entities decoded.
 */
export function toPlainText(html: string): string {
  return (
    html
      .replaceAll(ALLOWED_TAG_RE, (tag) => (tag.toLowerCase().startsWith('<br') ? '\n' : ''))
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      // `&amp;` last: decoding it earlier would let `&amp;lt;` become `<`.
      .replaceAll('&amp;', '&')
      .replaceAll(/[ \t]+/g, ' ')
      .trim()
  );
}
