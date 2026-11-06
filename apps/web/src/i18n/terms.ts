/**
 * Fills the `[[term]]` placeholders in the UI messages with the words in
 * `terms.json`, so renaming a term such as "user" or "organisation" is one edit
 * there. Part of the web app's i18n setup.
 *
 * A string whose other text is in Latin letters only is English (an
 * untranslated string in the hi or kn file) and takes the English words; any
 * other string, including one that is only placeholders, takes its locale's
 * words, then the English ones for a term the locale does not define.
 */
import { isJsonObject } from '../lib/json-object';
import terms from './terms.json';

type TermMap = Readonly<Record<string, string>>;

const TERMS: Readonly<Record<string, TermMap>> = terms;
const ENGLISH = 'en';
const PLACEHOLDER = /\[\[(\w+)\]\]/g;
const LATIN_LETTER = /\p{Script=Latin}/u;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/**
 * Whether a message is English, judged by its text outside the placeholders.
 *
 * @param text - Message text.
 * @returns `true` when that text has Latin letters and no other letters.
 */
function isEnglish(text: string): boolean {
  const rest = text.replace(PLACEHOLDER, '');
  return LATIN_LETTER.test(rest) && !NON_LATIN_LETTER.test(rest);
}

/**
 * Replaces the term placeholders in one message string.
 *
 * @param text - Message text that may contain `[[term]]` placeholders.
 * @param locale - Locale of the message file the text came from.
 * @returns The text with each known placeholder replaced; unknown ones are left as they are.
 */
export function fillTerms(text: string, locale: string): string {
  const english = TERMS[ENGLISH] ?? {};
  const own = isEnglish(text) ? {} : (TERMS[locale] ?? {});
  return text.replace(PLACEHOLDER, (match, key: string) => own[key] ?? english[key] ?? match);
}

/**
 * Returns a copy of a message catalogue with every term placeholder filled.
 *
 * Strings are filled, arrays and objects are copied with their values
 * filled, and any other value is returned as it is.
 *
 * @param messages - Message catalogue as loaded from `messages/<locale>.json`.
 * @param locale - Locale of the catalogue.
 * @returns The same structure with term placeholders replaced.
 */
export function applyTerms(
  messages: Record<string, unknown>,
  locale: string,
): Record<string, unknown>;
export function applyTerms(messages: unknown, locale: string): unknown;
export function applyTerms(messages: unknown, locale: string): unknown {
  if (typeof messages === 'string') return fillTerms(messages, locale);
  if (Array.isArray(messages)) return messages.map((m) => applyTerms(m, locale));
  if (isJsonObject(messages)) {
    return Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, applyTerms(v, locale)]));
  }
  return messages;
}
