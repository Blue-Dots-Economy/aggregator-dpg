/**
 * Builds a CSV from decrypted signalstack profiles for the aggregator's
 * "Export profile data" action. Belongs to @aggregator-dpg/api.
 *
 * Columns: `item_id` first, then identity-like columns (name fields, then
 * phone/mobile fields) regardless of the network-specific field names, then
 * the remaining union of item_state keys in alphabetical order. Values that
 * are objects/arrays are JSON-stringified; every field is neutralized against
 * spreadsheet formula injection and then RFC-4180 escaped.
 */
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';

/**
 * Ordered identity-column heuristics. Columns whose key matches an earlier
 * pattern lead; non-matching keys fall back to alphabetical order. Matching by
 * pattern (not a fixed key list) keeps this network-agnostic — it leads with
 * `name`/`phone` AND with network-specific names like `beneficiary_name` /
 * `mobile_number` without hardcoding per-network field names.
 */
const PRIORITY_PATTERNS = [/name/i, /phone|mobile|contact/i] as const;

/**
 * Priority rank of a column key — lower sorts first. Returns the index of the
 * first matching {@link PRIORITY_PATTERNS} entry, or a value past the end so
 * non-identity keys sort after all identity keys.
 *
 * @param key - The item_state field name.
 * @returns The sort rank (0-based; `PRIORITY_PATTERNS.length` when no match).
 */
function priorityRank(key: string): number {
  const idx = PRIORITY_PATTERNS.findIndex((re) => re.test(key));
  return idx === -1 ? PRIORITY_PATTERNS.length : idx;
}

/**
 * Neutralizes spreadsheet formula injection. Excel / Google Sheets interpret a
 * cell whose text begins with `=`, `+`, `-`, `@`, TAB, or CR as a formula, so
 * attacker-influenceable PII like `=HYPERLINK(...)` would execute on open.
 * Prefixing a single quote forces the cell to be treated as literal text.
 *
 * @param value - The raw cell string.
 * @returns The value, prefixed with `'` when it starts with a formula trigger.
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Escapes a single CSV field: first neutralizes formula triggers, then applies
 * RFC 4180 quoting (quote when it contains a comma, quote, CR, or LF; double
 * embedded quotes).
 *
 * @param value - The raw string value of the field.
 * @returns The formula-safe, RFC-4180 escaped field string.
 */
function csvField(value: string): string {
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Renders one item_state value to a CSV cell string. Objects/arrays become
 * compact JSON; null/undefined become an empty string.
 *
 * @param value - The raw value from item_state.
 * @returns The string representation suitable for a CSV cell.
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Builds the CSV body (CRLF line endings) from decrypted profile rows.
 *
 * @param rows - Decrypted profiles returned by signalstack.
 * @returns The CSV text. Header is just `item_id` when `rows` is empty.
 */
export function buildDecryptedProfilesCsv(rows: SignalStackDecryptedProfileRow[]): string {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.item_state ?? {})) keys.add(k);
  }
  const stateCols = [...keys].sort((a, b) => {
    const ra = priorityRank(a);
    const rb = priorityRank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  const header = ['item_id', ...stateCols];

  const lines = [header.map(csvField).join(',')];
  for (const r of rows) {
    const cells = [
      csvField(r.item_id),
      ...stateCols.map((c) => csvField(renderCell((r.item_state ?? {})[c]))),
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\r\n');
}
