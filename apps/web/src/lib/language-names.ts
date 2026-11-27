/**
 * Language names for voice bot languages.
 *
 * Config stores language codes (`hi`, `en`, `kn`); screens show them as names
 * in the language the page is displayed in.
 *
 * @module lib/language-names
 */

/** Separator between language names in one line of text. */
const LANGUAGE_SEPARATOR = ', ';

/**
 * Turns a language code into its name in `locale`, for example `hi` in `en`
 * gives "Hindi". Falls back to the raw code when the runtime does not know it.
 *
 * @param code - A language code from config, such as `hi`.
 * @param locale - The locale the name is written in, usually the current UI locale.
 * @returns The language name, or `code` when unsupported.
 */
export function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    // RangeError for a malformed code or locale.
    return code;
  }
}

/**
 * Joins language codes as comma-separated names in `locale`.
 *
 * @param codes - Language codes from config.
 * @param locale - The locale the names are written in.
 * @returns For example "Hindi, English".
 */
export function languageNames(codes: readonly string[], locale: string): string {
  return codes.map((code) => languageName(code, locale)).join(LANGUAGE_SEPARATOR);
}
