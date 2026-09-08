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
 * Column order for a participant schema: required properties first (in the
 * schema's own `required` order), then every remaining property in declaration
 * order.
 *
 * Exported because the XLSX template (`services/xlsx-template`) must produce
 * the SAME columns in the SAME order as the CSV one — an operator who fills the
 * workbook and exports it to CSV has to land on a file this repo's parser
 * accepts. Two copies of this rule would drift the moment a schema changed.
 *
 * @param schema - Participant JSON Schema.
 * @returns Property names in template column order.
 */
export function orderedColumns(schema: JsonSchema): string[] {
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
  return ordered;
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
  const ordered = orderedColumns(schema);

  const header = ordered.map(escapeCsvCell).join(',') + '\n';
  if (!exampleRow) return header;

  const example =
    ordered
      .map((name) => escapeCsvCell(exampleValue(name, properties[name] ?? {}, arrayDelimiter)))
      .join(',') + '\n';
  return header + example;
}

/** Reads a schema keyword as a string, or undefined when absent/wrong type. */
function str(prop: Record<string, unknown>, key: string): string | undefined {
  return typeof prop[key] === 'string' ? (prop[key] as string) : undefined;
}

/** Reads a schema keyword as a number, or undefined when absent/wrong type. */
function num(prop: Record<string, unknown>, key: string): number | undefined {
  return typeof prop[key] === 'number' ? (prop[key] as number) : undefined;
}

/**
 * Example for an array-typed property: two entries, so the cell demonstrates
 * the delimiter the parser splits on rather than looking like a single value.
 *
 * @param prop - The property's schema fragment.
 * @param arrayDelimiter - Delimiter to join with.
 * @returns The joined cell value.
 */
function arrayExample(prop: Record<string, unknown>, arrayDelimiter: string): string {
  const items = (prop['items'] as Record<string, unknown> | undefined) ?? {};
  const count = Math.max(2, num(prop, 'minItems') ?? 1);
  const itemEnum = Array.isArray(items['enum']) ? (items['enum'] as unknown[]) : undefined;
  const values = itemEnum
    ? itemEnum.slice(0, Math.min(count, itemEnum.length)).map(String)
    : Array.from({ length: count }, (_, i) => `example ${i + 1}`);
  return values.join(arrayDelimiter);
}

/**
 * Example for a numeric property: the midpoint when the schema bounds it on
 * both sides, so the value is inside the range rather than on an edge.
 *
 * @param prop - The property's schema fragment.
 * @param isInteger - Whether the schema type is `integer`.
 * @returns The number as a string.
 */
function numberExample(prop: Record<string, unknown>, isInteger: boolean): string {
  const min = num(prop, 'minimum');
  const max = num(prop, 'maximum');
  if (min !== undefined && max !== undefined) {
    const mid = (min + max) / 2;
    return String(isInteger ? Math.round(mid) : mid);
  }
  return String(min ?? max ?? 1);
}

/** Example for a recognised `format`, or undefined when the format is unknown. */
function formatExample(format: string | undefined): string | undefined {
  switch (format) {
    case 'email':
      return 'person@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'date':
      return '2024-01-01';
    case 'date-time':
      return '2024-01-01T00:00:00Z';
    default:
      return undefined;
  }
}

/**
 * A value that satisfies a simple `pattern`, or undefined when none can be
 * synthesised.
 *
 * Digit-run patterns are the common case in participant schemas — phone,
 * pincode, Aadhaar — and this handles the fixed (`{10}`) and bounded
 * (`{6,10}`) forms with an optional literal prefix (`^\+91[0-9]{10}$`), plus a
 * leading character class so `^[6-9][0-9]{9}$` gets a valid first digit.
 *
 * Whatever it builds is then TESTED against the pattern before being returned.
 * That is the point: an example that fails its own pattern is worse than no
 * example, because `bulk-row-process` treats a pattern miss as a blocking row
 * error — so an unrecognised shape, or a run longer than the digits available,
 * yields undefined and the caller leaves the cell blank rather than seeding a
 * value the parser will reject.
 *
 * @param pattern - The schema's `pattern`, when it declares one.
 * @returns A string matching the pattern, or undefined.
 */
function patternExample(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined;

  // ^<prefix?><[a-b]?>(digit-class){n[,m]}$ — the prefix is a literal run, the
  // optional leading class fixes the first digit (`^[6-9][0-9]{9}$`).
  const m =
    /^\^?((?:\\\+|\+)?[0-9A-Za-z-]*?)(?:\[(\d)-\d\])?(?:\[0-9\]|\\d)\{(\d+)(?:,(\d+))?\}\$?$/.exec(
      pattern,
    );
  if (!m) return undefined;

  const prefix = (m[1] ?? '').replace('\\+', '+');
  const firstDigit = m[2];
  const min = Number(m[3]);
  const runLength = firstDigit === undefined ? min : min + 1;
  const digits = '9876543210';
  if (runLength > digits.length * 4) return undefined;

  const body =
    (firstDigit ?? '') +
    digits
      .repeat(Math.ceil(runLength / digits.length))
      .slice(0, firstDigit === undefined ? min : min);
  const candidate = prefix + body;

  // The whole reason this function is allowed to guess: verify before emitting.
  try {
    return new RegExp(pattern).test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derives a deterministic, schema-valid example value for one property.
 *
 * Purely schema-driven (enum/format/pattern/bounds) — no field-name
 * heuristics, so it stays correct for any network's schemas.
 *
 * @param name - Property name, used only as a label fallback.
 * @param prop - The property's schema fragment.
 * @param arrayDelimiter - Delimiter for array-typed cells.
 * @returns The example cell value.
 */
export function exampleValue(
  name: string,
  prop: Record<string, unknown>,
  arrayDelimiter: string,
): string {
  const type = str(prop, 'type') ?? 'string';

  if (type === 'array') return arrayExample(prop, arrayDelimiter);

  const ownEnum = prop['enum'];
  if (Array.isArray(ownEnum) && ownEnum.length > 0) return String(ownEnum[0]);

  if (type === 'integer' || type === 'number') return numberExample(prop, type === 'integer');
  if (type === 'boolean') return 'true';

  const fromFormat = formatExample(str(prop, 'format'));
  if (fromFormat !== undefined) return fromFormat;

  const pattern = str(prop, 'pattern');
  const fromPattern = patternExample(pattern);
  if (fromPattern !== undefined) return fromPattern;
  // A pattern we could not satisfy: leave the cell blank. `Example <Title>`
  // would fail the pattern, and `bulk-row-process` treats that as a blocking
  // row error — the operator is better served by an empty cell and the note on
  // the allowed-values tab than by a value that is guaranteed to be rejected.
  if (pattern !== undefined) return '';

  const base = `Example ${str(prop, 'title') ?? name}`;
  const minLength = num(prop, 'minLength') ?? 0;
  return minLength > base.length ? base.padEnd(minLength, '.') : base;
}

function escapeCsvCell(value: string): string {
  if (value === '') return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
