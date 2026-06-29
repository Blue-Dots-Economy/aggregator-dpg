/**
 * Builds a CSV from decrypted signalstack profiles for the aggregator's
 * "Export profile data" action. Belongs to @aggregator-dpg/api.
 *
 * Columns: `item_id` first, then `name` and `phone` (when present), then the
 * remaining union of item_state keys in alphabetical order. Values that are
 * objects/arrays are JSON-stringified; all fields are RFC-4180 escaped.
 */
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';

const PRIORITY_KEYS = ['name', 'phone'] as const;

/**
 * Escapes a single CSV field per RFC 4180 (quote when it contains a comma,
 * quote, CR, or LF; double embedded quotes).
 *
 * @param value - The raw string value of the field.
 * @returns The RFC-4180 escaped field string.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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
  const priority = PRIORITY_KEYS.filter((k) => keys.has(k));
  const rest = [...keys]
    .filter((k) => !PRIORITY_KEYS.includes(k as (typeof PRIORITY_KEYS)[number]))
    .sort();
  const stateCols = [...priority, ...rest];
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
