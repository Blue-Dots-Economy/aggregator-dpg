/**
 * Format rules for an organisation's details, shared by the API (which
 * enforces them) and the console form (which checks before sending).
 *
 * Dependency-free so the web app can import it into the client bundle.
 *
 * @module @aggregator-dpg/shared-primitives/org-details
 */

/** One DNS label: letters and digits, with inner hyphens. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A top-level domain: letters only, at least two. */
const TOP_LEVEL_LABEL = /^[a-z]{2,}$/;

/** Required start of a website, compared case-insensitively. */
const HTTPS_PREFIX = 'https://';

/**
 * Whether `value` is an `https://` website with a real host name.
 *
 * Refuses a bare domain (`example.org`), `http://`, a host with no dot
 * (`https://localhost`), an IP address, credentials in the address, and any
 * whitespace inside it. Parsed with `URL` rather than one large regex, which
 * would backtrack slowly on long input.
 *
 * @param value - The website as typed; surrounding whitespace is ignored.
 * @returns True when the website is acceptable.
 */
export function isValidWebsite(value: string): boolean {
  const raw = value.trim();
  if (!raw.toLowerCase().startsWith(HTTPS_PREFIX) || /\s/.test(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  const labels = parsed.hostname.split('.');
  if (labels.length < 2) return false;
  const topLevel = labels.at(-1) ?? '';
  return TOP_LEVEL_LABEL.test(topLevel) && labels.every((label) => HOST_LABEL.test(label));
}

/** Alphabet of a GSTIN's characters, in check-character order. */
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * GSTIN shape: 2-digit state code, 10-character PAN, entity number (1-9 or a
 * letter), the letter `Z`, and the check character.
 */
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * Normalises a GSTIN as typed: trimmed and upper-cased.
 *
 * @param value - The GSTIN as typed.
 * @returns The normalised GSTIN.
 */
export function normaliseGstin(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The check character of a GSTIN's first 14 characters.
 *
 * Each character's value is multiplied by 1 and 2 alternately; the quotient
 * and remainder of each product by 36 are summed.
 *
 * @param first14 - The first 14 characters, already normalised.
 * @returns The expected 15th character.
 */
function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i += 1) {
    const product = GSTIN_ALPHABET.indexOf(first14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET.charAt((36 - (sum % 36)) % 36);
}

/**
 * Whether `value` is a well-formed Indian GSTIN with a correct check character.
 *
 * Checks the format only; it does not look the number up.
 *
 * @param value - The GSTIN as typed; normalised with {@link normaliseGstin} first.
 * @returns True when the GSTIN is well formed.
 */
export function isValidGstin(value: string): boolean {
  const gstin = normaliseGstin(value);
  if (!GSTIN_SHAPE.test(gstin)) return false;
  return gstinCheckCharacter(gstin.slice(0, 14)) === gstin.charAt(14);
}
