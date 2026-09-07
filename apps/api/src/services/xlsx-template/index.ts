/**
 * XLSX bulk-upload template generator (#564).
 *
 * The CSV template is what the parser accepts, but CSV cannot tell an operator
 * anything: no allowed values, no required/optional marking, no note that an
 * array cell is `|`-joined. Every one of those is a class of upload failure we
 * currently only report after the fact, per row, in `errors.csv`.
 *
 * A workbook can carry that guidance in the file itself. This module builds one
 * that an operator fills in and then exports with File → Save As → CSV, which
 * is the flow issue #564 asks for. The UPLOAD path is unchanged and still
 * accepts `.csv` only.
 *
 * ## Why generated, never shipped as a binary
 *
 * `config/<network>/bulk-samples/*.csv` is served verbatim when present. A
 * committed `.xlsx` would be the same idea, and it would rot the same way — the
 * shipped `up-gzb/provider.csv` still carries a `title` column the schema
 * dropped, so every one of its rows now fails validation. A workbook derived
 * from the live schema cannot drift from it.
 *
 * ## Columns come from the CSV generator
 *
 * `orderedColumns` is imported, not reimplemented: an operator's exported CSV
 * has to match what `bulk-row-process` expects, so the two templates must agree
 * on both the column set and its order. Same reason `exampleValue` is shared —
 * the example row is the CSV's, so what the workbook demonstrates is exactly
 * what the parser accepts.
 *
 * @module apps/api/services/xlsx-template
 */

import ExcelJS from 'exceljs';
import type { JsonSchema } from '@aggregator-dpg/schema-loader/interface';
import { exampleValue, orderedColumns } from '../csv-template/index.js';

/** Sheet holding the fillable grid — the only one an operator edits. */
const DATA_SHEET = 'Template';
/** Human-readable column guide. */
const GUIDE_SHEET = 'Column guide';
/**
 * Backing ranges for the dropdowns. Hidden rather than absent: Excel resolves
 * a list validation against a real range, so the values have to live in the
 * workbook somewhere.
 */
const LISTS_SHEET = 'Lists';

export interface XlsxTemplateOptions {
  /**
   * Delimiter for array-typed cells, from the network's `csv_array_delimiter`.
   * Shown in the guide and used in the example row, so the workbook documents
   * the delimiter the parser will actually split on.
   */
  arrayDelimiter?: string;
  /** Participant type, used for the sheet title only. */
  participantType?: string;
}

interface ColumnPlan {
  name: string;
  /**
   * The property's own schema fragment, kept verbatim so `exampleValue` sees
   * exactly what the CSV generator sees. Reconstructing a fragment from the
   * fields below would drop `format`, `pattern`, `minimum`/`maximum` and
   * `minLength`, and the workbook's example row would then differ from the CSV
   * template's for every numeric and formatted field.
   */
  prop: Record<string, unknown>;
  title: string;
  required: boolean;
  /** Closed value set, from `enum` or `items.enum`. */
  allowed: string[];
  isArray: boolean;
  /** `x-show-if` controller, when the field is conditional. */
  showIf?: string;
  description?: string;
}

/**
 * Reads a property into the facts the workbook needs.
 *
 * @param name - Property name.
 * @param prop - The property's schema fragment.
 * @param required - Whether the schema lists it as required.
 * @returns Plan for one column.
 */
function planColumn(name: string, prop: Record<string, unknown>, required: boolean): ColumnPlan {
  const items = prop['items'] as Record<string, unknown> | undefined;
  const ownEnum = Array.isArray(prop['enum']) ? (prop['enum'] as unknown[]) : undefined;
  const itemEnum = Array.isArray(items?.['enum']) ? (items?.['enum'] as unknown[]) : undefined;
  const showIfRaw = prop['x-show-if'];

  const plan: ColumnPlan = {
    name,
    prop,
    title: typeof prop['title'] === 'string' ? (prop['title'] as string) : name,
    required,
    allowed: (ownEnum ?? itemEnum ?? []).map(String),
    isArray: prop['type'] === 'array',
  };
  if (showIfRaw && typeof showIfRaw === 'object') {
    const controller = Object.keys(showIfRaw as Record<string, unknown>)[0];
    if (controller !== undefined) plan.showIf = controller;
  }
  if (typeof prop['description'] === 'string') plan.description = prop['description'] as string;
  return plan;
}

/**
 * Builds the XLSX bulk-upload template for a participant schema.
 *
 * @param schema - Participant JSON Schema (object-typed, draft 2020-12).
 * @param options - Array delimiter + participant type for titling.
 * @returns The workbook as a buffer, ready to send as an attachment.
 */
export async function buildXlsxTemplate(
  schema: JsonSchema,
  options: XlsxTemplateOptions = {},
): Promise<Buffer> {
  const { arrayDelimiter = '|', participantType = 'participant' } = options;
  const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );

  const plans = orderedColumns(schema).map((name) =>
    planColumn(name, properties[name] ?? {}, required.has(name)),
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Blue Dots Aggregator';
  wb.created = new Date();

  const lists = wb.addWorksheet(LISTS_SHEET);
  const listRanges = writeLists(lists, plans);
  // Hidden, not removed: the dropdowns reference these ranges, and an operator
  // editing them would silently widen what the schema accepts.
  lists.state = 'veryHidden';

  writeDataSheet(wb, plans, listRanges, arrayDelimiter, participantType);
  writeGuideSheet(wb, plans, arrayDelimiter);

  // exceljs declares its own `Buffer` interface, structurally unrelated to
  // Node's, so the cast goes through `unknown`. The value IS a Node Buffer.
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

/**
 * Writes one column of allowed values per closed-set field.
 *
 * Every dropdown is backed by a range rather than an inline list, uniformly.
 * Excel caps an inline list at 255 characters and ka-dhwd alone has three
 * fields far past it — `itiTrade` is 170 values / 5,555 characters — so
 * special-casing the long ones would mean two code paths where one behaves
 * differently only on the schemas nobody tests with.
 *
 * @param sheet - The hidden lists sheet.
 * @param plans - Column plans.
 * @returns Absolute range formula per column name.
 */
function writeLists(sheet: ExcelJS.Worksheet, plans: ColumnPlan[]): Map<string, string> {
  const ranges = new Map<string, string>();
  let col = 1;

  for (const plan of plans) {
    if (plan.allowed.length === 0) continue;
    const letter = columnLetter(col);
    sheet.getCell(1, col).value = plan.name;
    plan.allowed.forEach((value, i) => {
      sheet.getCell(i + 2, col).value = value;
    });
    // Quoted sheet name: 'Column guide' has a space, and so may a future sheet.
    ranges.set(plan.name, `'${LISTS_SHEET}'!$${letter}$2:$${letter}$${plan.allowed.length + 1}`);
    col += 1;
  }

  return ranges;
}

/**
 * Writes the fillable grid: header row, one example row, and per-column
 * validation.
 *
 * @param wb - Target workbook.
 * @param plans - Column plans.
 * @param listRanges - Range formula per closed-set column.
 * @param arrayDelimiter - Delimiter for array cells.
 * @param participantType - Used in the header note.
 */
function writeDataSheet(
  wb: ExcelJS.Workbook,
  plans: ColumnPlan[],
  listRanges: Map<string, string>,
  arrayDelimiter: string,
  participantType: string,
): void {
  const sheet = wb.addWorksheet(DATA_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = plans.map((plan) => ({
    header: plan.name,
    key: plan.name,
    width: Math.min(38, Math.max(14, plan.name.length + 4)),
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.height = 22;

  plans.forEach((plan, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      // Required columns are visually distinct because a missing required cell
      // is the one failure the operator can prevent before uploading.
      fgColor: { argb: plan.required ? 'FFFDE68A' : 'FFF1F5F9' },
    };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    cell.note = headerNote(plan, arrayDelimiter);
  });

  // The example row is the CSV generator's, so the workbook demonstrates
  // exactly what the parser accepts. Operators overwrite it.
  const example = plans.map((plan) => exampleValue(plan.name, plan.prop, arrayDelimiter));
  const exampleRow = sheet.addRow(example);
  exampleRow.font = { italic: true, color: { argb: 'FF64748B' } };

  // Validation over a generous row range: an operator pasting 500 rows should
  // keep the dropdowns rather than lose them past the seeded rows.
  const lastRow = 500;
  plans.forEach((plan, i) => {
    const range = listRanges.get(plan.name);
    if (!range) return;
    // An array column takes several values in one `|`-joined cell, so a
    // single-value dropdown would reject valid input. The allowed values are in
    // the guide sheet and the header note instead.
    if (plan.isArray) return;

    for (let row = 2; row <= lastRow; row += 1) {
      sheet.getCell(row, i + 1).dataValidation = {
        type: 'list',
        allowBlank: !plan.required,
        formulae: [range],
        showErrorMessage: true,
        errorStyle: 'error',
        errorTitle: 'Value not allowed',
        error: `Pick one of the listed values for "${plan.name}". See the "${GUIDE_SHEET}" sheet.`,
      };
    }
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: plans.length },
  };
  void participantType;
}

/**
 * Writes the human-readable guide — the part that makes the standards
 * identifiable without reading a schema.
 *
 * @param wb - Target workbook.
 * @param plans - Column plans.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeGuideSheet(wb: ExcelJS.Workbook, plans: ColumnPlan[], arrayDelimiter: string): void {
  const sheet = wb.addWorksheet(GUIDE_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = [
    { header: 'Column', key: 'column', width: 34 },
    { header: 'Required', key: 'required', width: 10 },
    { header: 'Multiple values', key: 'multi', width: 15 },
    { header: 'Only fill in when', key: 'showIf', width: 26 },
    { header: 'Allowed values', key: 'allowed', width: 90 },
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

  for (const plan of plans) {
    sheet.addRow({
      column: plan.name,
      required: plan.required ? 'Yes' : 'No',
      multi: plan.isArray ? `Yes — join with ${arrayDelimiter}` : 'No',
      showIf: plan.showIf ? `${plan.showIf} is set` : '',
      allowed:
        plan.allowed.length > 0 ? plan.allowed.join(', ') : (plan.description ?? 'Free text'),
    });
  }

  sheet.getColumn('allowed').alignment = { wrapText: true, vertical: 'top' };
}

/** The note attached to a header cell — the guidance an operator sees in place. */
function headerNote(plan: ColumnPlan, arrayDelimiter: string): string {
  const lines = [`${plan.title}${plan.required ? ' (required)' : ' (optional)'}`];
  if (plan.isArray) {
    lines.push(`Several values allowed — join them with "${arrayDelimiter}".`);
  }
  if (plan.allowed.length > 0) {
    lines.push(
      plan.allowed.length <= 12
        ? `Allowed: ${plan.allowed.join(', ')}`
        : `${plan.allowed.length} allowed values — see the "${GUIDE_SHEET}" sheet.`,
    );
  }
  if (plan.showIf) lines.push(`Only applies when "${plan.showIf}" is set.`);
  return lines.join('\n');
}

/** 1-based column index to its spreadsheet letter (1 → A, 27 → AA). */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
