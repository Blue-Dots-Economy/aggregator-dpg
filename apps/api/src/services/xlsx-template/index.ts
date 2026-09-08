/**
 * XLSX bulk-upload template generator (#564).
 *
 * The CSV template is what the parser accepts, but CSV cannot tell an operator
 * anything: not which columns are required, not which values a closed set
 * accepts, not that an array cell is delimiter-joined. Each of those is a class
 * of upload failure we currently only report after the fact, per row, in
 * `errors.csv`.
 *
 * This builds the workbook an operator fills in and then exports with
 * File > Save As > CSV, which is the flow issue #564 asks for. The UPLOAD path
 * is unchanged and still accepts `.csv` only.
 *
 * ## Layout follows the reference workbook attached to #564
 *
 * One `Instructions` sheet, then a group of three sheets per served domain,
 * then the hidden ranges the dropdowns resolve against:
 *
 * ```
 * Instructions
 * sample_<network>_<type>s    filled example rows - read, do not edit
 * <network>_<type>s_data      the empty grid to fill in, with the dropdowns
 * enumerated_<type>           allowed values, one column per closed set
 * Lists                       veryHidden; the ranges validation points at
 * ```
 *
 * Keeping the samples out of the grid is the reference's idea and a good one:
 * an example row sitting inside the sheet you are filling either gets uploaded
 * by accident or deleted before it has been read.
 *
 * ## Why generated, never shipped as a binary
 *
 * This repo used to ship `config/<network>/bulk-samples/*.csv` and serve them
 * verbatim. They rotted: against the live ka-dhwd schemas those files carried
 * 24 columns to the schema's 36, 18 of 20 seeker rows failed on outdated enum
 * values, and every provider row failed on a `title` column the schema had
 * dropped. They are deleted, and a committed workbook would have been the same
 * mistake in a harder-to-inspect format. Every column, dropdown and sample row
 * here comes from the schema resolved out of `network.json` at boot, so the
 * template cannot demonstrate something the parser rejects.
 *
 * ## Columns come from the CSV generator
 *
 * `orderedColumns` is imported, not reimplemented: an operator's exported CSV
 * has to be a file `bulk-row-process` accepts, so both templates must agree on
 * the column set AND its order. `exampleValue` is shared for the same reason.
 *
 * @module apps/api/services/xlsx-template
 */

import ExcelJS from 'exceljs';
import type { JsonSchema } from '@aggregator-dpg/schema-loader/interface';
import { exampleValue, orderedColumns } from '../csv-template/index.js';

/** Shared guidance sheet, first in the tab order. */
const INSTRUCTIONS_SHEET = 'Instructions';
/**
 * Backing ranges for every dropdown across every domain. Hidden rather than
 * absent: Excel resolves a list validation against a real range, so the values
 * have to live in the workbook somewhere, and an operator editing them would
 * silently widen what the schema accepts.
 */
const LISTS_SHEET = 'Lists';
/** Rows the fill-in grid carries validation for - generous, so pasting keeps it. */
const VALIDATED_ROWS = 500;
/** Cap on generated sample rows per domain, matching the reference's ~10. */
const MAX_SAMPLE_ROWS = 10;
/** Excel's hard limit on a worksheet name. */
const SHEET_NAME_MAX = 31;

/**
 * Operator guidance, carried over from the reference workbook attached to the
 * issue. The Admin Details block that workbook ends with is deliberately not
 * reproduced - it is deployment paperwork, not instructions for filling a row.
 */
const INSTRUCTIONS: readonly string[] = [
  '1. Open the "sample_" tab for your participant type to see how a row should look.',
  '2. Enter your own rows in the matching "_data" tab. Do not edit the sample tabs.',
  '3. Leave any field you do not have a value for blank.',
  '4. Name, phone and an accurate location are required. Without them a participant will not show on the map.',
  '5. Job title / role names drive search and match quality. The more complete the row, the better the result.',
  '6. Columns with a dropdown accept only the listed values. The "enumerated_" tabs list every one of them.',
  '7. A column marked "several values" takes more than one, joined with the delimiter shown on that tab.',
  '8. When you are done, upload the "_data" tab only, saved as CSV (File > Save As > CSV).',
];

/** One served domain and the schema its columns come from. */
export interface XlsxDomain {
  /** Domain id as declared by the network, e.g. `seeker`. */
  id: string;
  /** Participant JSON Schema (object-typed, draft 2020-12) for that domain. */
  schema: JsonSchema;
  /**
   * The domain's identity selectors (`ResolvedDomain.identity`), naming which
   * columns hold the name / phone / email.
   *
   * Used only to make those sample cells realistic. `exampleValue` is purely
   * schema-driven by design — no field-name heuristics — so where a schema
   * declares no `format` or `pattern`, a phone column samples as "Example
   * Mobile Number", which the row parser would reject. That is the worst cell
   * in the workbook to get wrong: phone is what the network dedups and
   * notifies on. Config says which column it is, so nothing is guessed here.
   */
  identity?: { name: string; phone: string; email?: string | undefined } | undefined;
}

export interface XlsxTemplateOptions {
  /** Network id, used in the sheet names (`sample_blue_dot_seekers`). */
  network?: string;
  /**
   * Delimiter for array-typed cells, from the network's `csv_array_delimiter`.
   * Shown on the enumerated tabs and used in the sample rows, so the workbook
   * documents the delimiter the parser will actually split on.
   */
  arrayDelimiter?: string;
}

interface ColumnPlan {
  name: string;
  /**
   * The property's own schema fragment, kept verbatim so `exampleValue` sees
   * exactly what the CSV generator sees. Reconstructing one from the fields
   * below would drop `format`, `pattern`, `minimum`/`maximum` and `minLength`,
   * and the sample rows would then differ from the CSV template's for every
   * numeric and formatted field.
   */
  prop: Record<string, unknown>;
  title: string;
  required: boolean;
  /** Closed value set, from `enum` or `items.enum`. */
  allowed: string[];
  isArray: boolean;
  /** `x-show-if` controller field, when this column is conditional. */
  showIfField?: string;
  /** Controller values that make this column apply. */
  showIfValues: string[];
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

  const plan: ColumnPlan = {
    name,
    prop,
    title: typeof prop['title'] === 'string' ? (prop['title'] as string) : name,
    required,
    allowed: (ownEnum ?? itemEnum ?? []).map(String),
    isArray: prop['type'] === 'array',
    showIfValues: [],
  };

  const showIf = prop['x-show-if'];
  if (showIf && typeof showIf === 'object') {
    const [field, values] = Object.entries(showIf as Record<string, unknown>)[0] ?? [];
    if (field !== undefined) {
      plan.showIfField = field;
      plan.showIfValues = Array.isArray(values) ? values.map(String) : [];
    }
  }
  if (typeof prop['description'] === 'string') plan.description = prop['description'] as string;
  return plan;
}

/** Plural of a domain id for the sheet names: `seeker` becomes `seekers`. */
function plural(id: string): string {
  return id.endsWith('s') ? id : `${id}s`;
}

/**
 * Picks the first candidate name Excel will accept.
 *
 * Worksheet names are capped at 31 characters, and
 * `sample_blue_dot_service_providers` is 33 - so the network-qualified name has
 * to be able to fall back to an unqualified one rather than being silently
 * truncated into a collision with its neighbour.
 *
 * @param candidates - Preferred names, most-qualified first.
 * @returns The first candidate within Excel's limit, else the last one truncated.
 */
function fitSheetName(candidates: readonly string[]): string {
  for (const name of candidates) {
    if (name.length <= SHEET_NAME_MAX) return name;
  }
  return (candidates[candidates.length - 1] ?? 'Sheet').slice(0, SHEET_NAME_MAX);
}

/**
 * Sheet name for a domain's read-only examples.
 *
 * @param network - Network id.
 * @param domainId - Domain id.
 * @returns Worksheet name within Excel's 31-character limit.
 */
export function sampleSheetName(network: string, domainId: string): string {
  return fitSheetName([
    `sample_${network}_${plural(domainId)}`,
    `sample_${plural(domainId)}`,
    `sample_${domainId}`,
  ]);
}

/**
 * Sheet name for the grid an operator fills in.
 *
 * @param network - Network id.
 * @param domainId - Domain id.
 * @returns Worksheet name within Excel's 31-character limit.
 */
export function dataSheetName(network: string, domainId: string): string {
  return fitSheetName([
    `${network}_${plural(domainId)}_data`,
    `${plural(domainId)}_data`,
    `${domainId}_data`,
  ]);
}

/**
 * Sheet name for a domain's allowed-values reference.
 *
 * @param domainId - Domain id.
 * @returns Worksheet name within Excel's 31-character limit.
 */
export function enumeratedSheetName(domainId: string): string {
  return fitSheetName([`enumerated_${domainId}`, domainId]);
}

/**
 * Builds the XLSX bulk-upload template covering every served domain.
 *
 * @param domains - Served domains and their participant schemas, in tab order.
 * @param options - Network id and array delimiter.
 * @returns The workbook as a buffer, ready to send as an attachment.
 */
export async function buildXlsxTemplate(
  domains: readonly XlsxDomain[],
  options: XlsxTemplateOptions = {},
): Promise<Buffer> {
  const { network = 'network', arrayDelimiter = '|' } = options;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Blue Dots Aggregator';
  wb.created = new Date();

  writeInstructions(wb, domains, network);

  // One lists sheet for the whole workbook, so a column name alone is not a
  // unique key - the same field name exists on more than one domain with
  // different options. The range map is keyed `<domain>.<column>`.
  const lists = wb.addWorksheet(LISTS_SHEET);
  const ranges = new Map<string, string>();
  let listCol = 1;

  const planned = domains.map((domain) => {
    const properties =
      (domain.schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
    const required = new Set(
      Array.isArray(domain.schema['required']) ? (domain.schema['required'] as string[]) : [],
    );
    const plans = orderedColumns(domain.schema).map((name) =>
      planColumn(name, properties[name] ?? {}, required.has(name)),
    );
    listCol = writeLists(lists, domain.id, plans, ranges, listCol);
    return { domain, plans };
  });

  // Hidden only after every domain has contributed its ranges.
  lists.state = 'veryHidden';

  for (const { domain, plans } of planned) {
    writeSampleSheet(wb, network, domain.id, plans, arrayDelimiter, domain.identity);
    writeDataSheet(wb, network, domain.id, plans, ranges, arrayDelimiter);
    writeEnumeratedSheet(wb, domain.id, plans, arrayDelimiter);
  }

  // exceljs declares its own `Buffer` interface, structurally unrelated to
  // Node's, so the cast goes through `unknown`. The value IS a Node Buffer.
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

/**
 * Writes the guidance sheet, naming the tabs this workbook actually has.
 *
 * @param wb - Target workbook.
 * @param domains - Served domains.
 * @param network - Network id, so the listed tab names match the real ones.
 */
function writeInstructions(
  wb: ExcelJS.Workbook,
  domains: readonly XlsxDomain[],
  network: string,
): void {
  const sheet = wb.addWorksheet(INSTRUCTIONS_SHEET);
  sheet.getColumn(1).width = 118;

  const title = sheet.addRow(['Bulk upload - how to use this workbook']);
  title.font = { bold: true, size: 14 };
  sheet.addRow([]);
  for (const line of INSTRUCTIONS) {
    sheet.addRow([line]).alignment = { wrapText: true, vertical: 'top' };
  }
  sheet.addRow([]);

  sheet.addRow(['Tabs in this workbook']).font = { bold: true };
  for (const domain of domains) {
    sheet.addRow([
      `${domain.id} - examples: "${sampleSheetName(network, domain.id)}"` +
        `  |  fill in: "${dataSheetName(network, domain.id)}"` +
        `  |  allowed values: "${enumeratedSheetName(domain.id)}"`,
    ]);
  }
}

/**
 * Writes one column of allowed values per closed-set field, for one domain.
 *
 * Every dropdown is range-backed rather than inline, uniformly. Excel caps an
 * inline list at 255 characters and ka-dhwd alone has three fields far past it
 * (`itiTrade` is 170 values / 5,555 characters), so special-casing the long
 * ones would mean two code paths where one is exercised only by the schemas
 * nobody tests with.
 *
 * @param sheet - The hidden lists sheet, shared by every domain.
 * @param domainId - Domain the columns belong to.
 * @param plans - Column plans.
 * @param ranges - Range map to populate, keyed `<domain>.<column>`.
 * @param startCol - First free column on the lists sheet.
 * @returns The next free column.
 */
function writeLists(
  sheet: ExcelJS.Worksheet,
  domainId: string,
  plans: readonly ColumnPlan[],
  ranges: Map<string, string>,
  startCol: number,
): number {
  let col = startCol;
  for (const plan of plans) {
    if (plan.allowed.length === 0) continue;
    const letter = columnLetter(col);
    sheet.getCell(1, col).value = `${domainId}.${plan.name}`;
    plan.allowed.forEach((value, i) => {
      sheet.getCell(i + 2, col).value = value;
    });
    ranges.set(
      `${domainId}.${plan.name}`,
      `'${LISTS_SHEET}'!$${letter}$2:$${letter}$${plan.allowed.length + 1}`,
    );
    col += 1;
  }
  return col;
}

/**
 * Generates sample rows that demonstrate the conditional fields.
 *
 * One row cannot show that `stipendMin` applies to an Internship while
 * `salaryMin` applies to a Full-time role, and those `x-show-if` pairs are most
 * of what an operator gets wrong. So a row is emitted per controller value: the
 * controller is pinned, the fields that value unlocks are filled, and the
 * fields it does not unlock are left blank, which is exactly the shape the
 * schema expects.
 *
 * @param plans - Column plans.
 * @param arrayDelimiter - Delimiter for array cells.
 * @param identity - The domain's identity selectors, when configured.
 * @returns Rows as arrays positionally aligned to `plans`.
 */
function sampleRows(
  plans: readonly ColumnPlan[],
  arrayDelimiter: string,
  identity?: XlsxDomain['identity'],
): string[][] {
  const controllers = new Map<string, string[]>();
  for (const plan of plans) {
    if (plan.showIfField === undefined || controllers.has(plan.showIfField)) continue;
    const controller = plans.find((p) => p.name === plan.showIfField);
    if (controller && controller.allowed.length > 0) {
      controllers.set(plan.showIfField, controller.allowed);
    }
  }

  /** One row: `pins` fixes controller values, everything unconditional is filled. */
  const buildRow = (pins: Map<string, string>): string[] =>
    plans.map((plan) => {
      const pinned = pins.get(plan.name);
      if (pinned !== undefined) return pinned;

      if (plan.showIfField !== undefined) {
        const controllerValue = pins.get(plan.showIfField);
        // Blank unless this row's controller value actually unlocks the field -
        // a filled-in conditional that does not apply is the wrong example.
        if (controllerValue === undefined) return '';
        if (plan.showIfValues.length > 0 && !plan.showIfValues.includes(controllerValue)) return '';
      }
      if (identity !== undefined) {
        if (plan.name === identity.phone) return '9876543210';
        if (plan.name === identity.email) return 'person@example.com';
      }
      return exampleValue(plan.name, plan.prop, arrayDelimiter);
    });

  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const [field, values] of controllers) {
    for (const value of values) {
      if (rows.length >= MAX_SAMPLE_ROWS) break;
      const row = buildRow(new Map([[field, value]]));
      const key = row.join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (rows.length >= MAX_SAMPLE_ROWS) break;
  }

  // A schema with no conditionals still deserves one worked example.
  if (rows.length === 0) rows.push(buildRow(new Map()));
  return rows;
}

/**
 * Writes the read-only examples sheet for one domain.
 *
 * @param wb - Target workbook.
 * @param network - Network id.
 * @param domainId - Domain id.
 * @param plans - Column plans.
 * @param arrayDelimiter - Delimiter for array cells.
 * @param identity - The domain's identity selectors, when configured.
 */
function writeSampleSheet(
  wb: ExcelJS.Workbook,
  network: string,
  domainId: string,
  plans: readonly ColumnPlan[],
  arrayDelimiter: string,
  identity?: XlsxDomain['identity'],
): void {
  const sheet = wb.addWorksheet(sampleSheetName(network, domainId), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  applyColumns(sheet, plans);
  styleHeader(sheet, plans);

  for (const row of sampleRows(plans, arrayDelimiter, identity)) {
    sheet.addRow(row).font = { color: { argb: 'FF475569' } };
  }
}

/**
 * Writes the empty grid an operator fills in - the sheet the dropdowns live on.
 *
 * @param wb - Target workbook.
 * @param network - Network id.
 * @param domainId - Domain id.
 * @param plans - Column plans.
 * @param ranges - Range map from {@link writeLists}.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeDataSheet(
  wb: ExcelJS.Workbook,
  network: string,
  domainId: string,
  plans: readonly ColumnPlan[],
  ranges: ReadonlyMap<string, string>,
  arrayDelimiter: string,
): void {
  const sheet = wb.addWorksheet(dataSheetName(network, domainId), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  applyColumns(sheet, plans);
  styleHeader(sheet, plans, arrayDelimiter);

  const enumeratedTab = enumeratedSheetName(domainId);
  plans.forEach((plan, i) => {
    const range = ranges.get(`${domainId}.${plan.name}`);
    if (range === undefined) return;
    // An array column takes several values in one delimiter-joined cell, so a
    // single-value dropdown would reject valid input. Its allowed values are on
    // the enumerated tab and in the header note instead.
    if (plan.isArray) return;

    for (let row = 2; row <= VALIDATED_ROWS; row += 1) {
      sheet.getCell(row, i + 1).dataValidation = {
        type: 'list',
        allowBlank: !plan.required,
        formulae: [range],
        showErrorMessage: true,
        errorStyle: 'error',
        errorTitle: 'Value not allowed',
        error: `Pick one of the listed values for "${plan.name}". See the "${enumeratedTab}" tab.`,
      };
    }
  });

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: plans.length } };
}

/**
 * Writes the allowed-values tab in the reference workbook's shape: a
 * `domain` / `field` / `options` row stack, one column per closed set, options
 * delimiter-joined so the whole set is readable in one cell.
 *
 * @param wb - Target workbook.
 * @param domainId - Domain id.
 * @param plans - Column plans.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeEnumeratedSheet(
  wb: ExcelJS.Workbook,
  domainId: string,
  plans: readonly ColumnPlan[],
  arrayDelimiter: string,
): void {
  const sheet = wb.addWorksheet(enumeratedSheetName(domainId));
  const labels = ['domain', 'field', 'options', 'several values', 'only fill in when'];
  labels.forEach((label, i) => {
    const cell = sheet.getCell(i + 1, 1);
    cell.value = label;
    cell.font = { bold: true };
  });
  sheet.getColumn(1).width = 20;

  plans
    .filter((plan) => plan.allowed.length > 0)
    .forEach((plan, i) => {
      const col = i + 2;
      sheet.getCell(1, col).value = domainId;
      sheet.getCell(2, col).value = plan.name;
      sheet.getCell(3, col).value = plan.allowed.join(arrayDelimiter);
      sheet.getCell(4, col).value = plan.isArray ? `yes - join with ${arrayDelimiter}` : 'no';
      sheet.getCell(5, col).value =
        plan.showIfField === undefined
          ? ''
          : `${plan.showIfField} = ${plan.showIfValues.join(arrayDelimiter) || 'any value'}`;
      sheet.getColumn(col).width = 42;
      sheet.getCell(3, col).alignment = { wrapText: true, vertical: 'top' };
    });
}

/**
 * Lays out one column per planned field, in the CSV template's order.
 *
 * @param sheet - Sheet to lay out.
 * @param plans - Column plans.
 */
function applyColumns(sheet: ExcelJS.Worksheet, plans: readonly ColumnPlan[]): void {
  sheet.columns = plans.map((plan) => ({
    header: plan.name,
    key: plan.name,
    width: Math.min(38, Math.max(14, plan.name.length + 4)),
  }));
}

/**
 * Applies the shared header styling, and per-column notes when a delimiter is
 * given (the fill-in grid; the sample sheets are read-only and carry none).
 *
 * @param sheet - Sheet whose row 1 is the header.
 * @param plans - Column plans.
 * @param arrayDelimiter - When given, attach header notes mentioning it.
 */
function styleHeader(
  sheet: ExcelJS.Worksheet,
  plans: readonly ColumnPlan[],
  arrayDelimiter?: string,
): void {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.height = 22;

  plans.forEach((plan, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      // Required columns are visually distinct because a missing required cell
      // is the one failure an operator can prevent before uploading.
      fgColor: { argb: plan.required ? 'FFFDE68A' : 'FFF1F5F9' },
    };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    if (arrayDelimiter !== undefined) cell.note = headerNote(plan, arrayDelimiter);
  });
}

/**
 * Builds the note attached to a header cell - the guidance an operator sees
 * without leaving the cell they are typing in.
 *
 * @param plan - The column.
 * @param arrayDelimiter - Delimiter for array cells.
 * @returns Note text.
 */
function headerNote(plan: ColumnPlan, arrayDelimiter: string): string {
  const lines = [`${plan.title}${plan.required ? ' (required)' : ' (optional)'}`];
  if (plan.description !== undefined) lines.push(plan.description);
  if (plan.isArray) lines.push(`Several values allowed - join them with "${arrayDelimiter}".`);
  if (plan.allowed.length > 0) {
    lines.push(
      plan.allowed.length <= 12
        ? `Allowed: ${plan.allowed.join(', ')}`
        : `${plan.allowed.length} allowed values - see the enumerated tab.`,
    );
  }
  if (plan.showIfField !== undefined) {
    lines.push(
      `Only applies when "${plan.showIfField}" is ${plan.showIfValues.join(' / ') || 'set'}.`,
    );
  }
  return lines.join('\n');
}

/** 1-based column index to its spreadsheet letter (1 becomes A, 27 becomes AA). */
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
