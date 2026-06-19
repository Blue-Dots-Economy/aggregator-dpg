/**
 * CSV template generator for bulk uploads. Produces a header row in
 * schema-property order (required first, then optional) plus one fully
 * populated example row derived from the JSON Schema, so non-technical
 * operators can see exactly how to format each cell — in particular how
 * array fields are joined with the network's CSV delimiter (#405).
 *
 * @module apps/api/services/csv-template
 */

import type { JsonSchema } from '@aggregator-dpg/schema-loader/interface';

export interface CsvTemplateOptions {
  /**
   * Delimiter used to join array-typed cells, from the network binding's
   * `csv_array_delimiter`. Must match what the bulk parser splits on
   * (`apps/worker/src/jobs/bulk-row-process.ts`).
   */
  arrayDelimiter?: string;
  /** Set false to emit the legacy header-only template. */
  exampleRow?: boolean;
}

/**
 * Builds the downloadable CSV template for a participant schema.
 *
 * @param schema - The participant JSON Schema (object-typed, draft 2020-12).
 * @param options - Array delimiter + example-row toggle.
 * @returns CSV text: header line, then (by default) one example line.
 */
export function buildCsvTemplate(schema: JsonSchema, options: CsvTemplateOptions = {}): string {
  const { arrayDelimiter = '|', exampleRow = true } = options;
  const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const requiredSet = new Set(required);

  const ordered: string[] = [];
  for (const r of required) {
    if (properties[r]) ordered.push(r);
  }
  for (const name of Object.keys(properties)) {
    if (!requiredSet.has(name)) ordered.push(name);
  }

  const header = ordered.map(escapeCsvCell).join(',') + '\n';
  if (!exampleRow) return header;

  const example =
    ordered
      .map((name) => escapeCsvCell(exampleValue(name, properties[name] ?? {}, arrayDelimiter)))
      .join(',') + '\n';
  return header + example;
}

/**
 * Derives a deterministic, schema-valid example value for one property.
 * Purely schema-driven (enum/format/pattern/bounds) — no field-name
 * heuristics, so it stays correct for any network's schemas.
 */
function exampleValue(name: string, prop: Record<string, unknown>, arrayDelimiter: string): string {
  const type = typeof prop['type'] === 'string' ? (prop['type'] as string) : 'string';

  if (type === 'array') {
    const items = (prop['items'] as Record<string, unknown> | undefined) ?? {};
    const minItems = typeof prop['minItems'] === 'number' ? (prop['minItems'] as number) : 1;
    const count = Math.max(2, minItems); // two entries demonstrate the delimiter
    const itemEnum = Array.isArray(items['enum']) ? (items['enum'] as unknown[]) : undefined;
    const values = itemEnum
      ? itemEnum.slice(0, Math.min(count, itemEnum.length)).map(String)
      : Array.from({ length: count }, (_, i) => `example ${i + 1}`);
    return values.join(arrayDelimiter);
  }

  if (Array.isArray(prop['enum']) && (prop['enum'] as unknown[]).length > 0) {
    return String((prop['enum'] as unknown[])[0]);
  }

  if (type === 'integer' || type === 'number') {
    const min = typeof prop['minimum'] === 'number' ? (prop['minimum'] as number) : undefined;
    const max = typeof prop['maximum'] === 'number' ? (prop['maximum'] as number) : undefined;
    if (min !== undefined && max !== undefined) {
      const mid = (min + max) / 2;
      return String(type === 'integer' ? Math.round(mid) : mid);
    }
    return String(min ?? max ?? 1);
  }

  if (type === 'boolean') return 'true';

  // string
  const format = typeof prop['format'] === 'string' ? (prop['format'] as string) : undefined;
  if (format === 'email') return 'person@example.com';
  if (format === 'uri' || format === 'url') return 'https://example.com';
  if (format === 'date') return '2024-01-01';
  if (format === 'date-time') return '2024-01-01T00:00:00Z';

  const pattern = typeof prop['pattern'] === 'string' ? (prop['pattern'] as string) : undefined;
  if (pattern) {
    // Digit-run patterns (`^[0-9]{10}$`, `^\d{6}$`) are the common case in
    // participant schemas (phone, pincode); synthesise a matching run.
    const digits = /^\^?(?:\[0-9\]|\\d)\{(\d+)\}\$?$/.exec(pattern);
    if (digits) return '9876543210'.repeat(2).slice(0, Number(digits[1]));
  }

  const title = typeof prop['title'] === 'string' ? (prop['title'] as string) : name;
  const base = `Example ${title}`;
  const minLength = typeof prop['minLength'] === 'number' ? (prop['minLength'] as number) : 0;
  return minLength > base.length ? base.padEnd(minLength, '.') : base;
}

function escapeCsvCell(value: string): string {
  if (value === '') return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
