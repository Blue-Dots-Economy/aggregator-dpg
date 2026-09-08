/**
 * XLSX bulk-upload template generator (#564).
 *
 * The CSV template is what the parser accepts, but CSV cannot tell an operator
 * anything: not which columns are required, not which values a closed set
 * accepts, not that an array cell is delimiter-joined. Each of those is a class
 * of upload failure we otherwise only report after the fact, per row, in
 * `errors.csv`.
 *
 * This builds the workbook an operator fills in and then exports with
 * File > Save As > CSV. The UPLOAD path is unchanged and still accepts `.csv`.
 *
 * ## One workbook per participant type, four tabs
 *
 * ```
 * 1. Instructions        what to do, and the legend for the colours
 * 2. Allowed values      every column, closed sets first, with its label
 * 3. Sample data         worked rows covering every conditional branch
 * 4. Enter your <type>s  the empty grid to fill, with the dropdowns
 * ```
 *
 * A coordinator is scoped to a single participant type, so a per-type file is
 * the smallest thing that can be handed to the person doing the typing: four
 * tabs instead of one workbook's worth of every domain the network serves.
 *
 * ## Why the grid keeps machine-name headers
 *
 * `network.json` gives every field a human `title` ("Mobile Number" for
 * `phone`), and those read far better as headers — but the exported CSV's
 * header line is what `bulk-file-stream` matches against, and it matches field
 * names. Until the parser accepts titles too, the grid's header row has to be
 * the field names, and it has to be the ONLY row above the data: a label row or
 * a merged section banner would leave an extra line in the exported CSV and
 * fail the upload. So the labels live on tabs 2 and 3 and in each header cell's
 * note, and the grid conveys structure with colour instead.
 *
 * ## Generated, never shipped as a binary
 *
 * This repo used to ship `config/<network>/bulk-samples/*.csv` and serve them
 * verbatim. They rotted: against the live ka-dhwd schemas those files carried
 * 24 columns to the schema's 36, and 18 of 20 seeker rows failed on outdated
 * enum values. They are deleted. Every column, dropdown and sample row here
 * comes from the schema resolved out of `network.json` at boot, so the template
 * cannot demonstrate something the parser rejects.
 *
 * @module apps/api/services/xlsx-template
 */

import ExcelJS from 'exceljs';
import type { JsonSchema } from '@aggregator-dpg/schema-loader/interface';
import { exampleValue, orderedColumns } from '../csv-template/index.js';

/** Tab 1 — what to do. */
const INSTRUCTIONS_SHEET = '1. Instructions';
/** Tab 2 — the closed sets, then every remaining column. */
const VALUES_SHEET = '2. Allowed values';
/** Tab 3 — worked examples, locked. */
const SAMPLE_SHEET = '3. Sample data';
/**
 * Backing ranges for the dropdowns. Hidden rather than absent: Excel resolves
 * a list validation against a real range, so the values have to live in the
 * workbook somewhere, and an operator editing them would silently widen what
 * the schema accepts.
 */
const LISTS_SHEET = 'Lists';
/** Rows the grid carries validation for — generous, so pasting keeps it. */
const VALIDATED_ROWS = 500;
/** Upper bound on generated sample rows. */
const MAX_SAMPLE_ROWS = 14;
/** Excel's hard limit on a worksheet name. */
const SHEET_NAME_MAX = 31;

/** Header fill for a required column. */
const FILL_REQUIRED = 'FFFDE68A';
/** Header fill for a column that only applies in some cases. */
const FILL_CONDITIONAL = 'FFE2E8F0';
/** Header fill for an ordinary optional column. */
const FILL_OPTIONAL = 'FFF8FAFC';
/** Tab colours: the grid is the one an operator edits, so it reads "go". */
const TAB_COLOURS = {
  instructions: 'FF94A3B8',
  values: 'FF60A5FA',
  sample: 'FFFBBF24',
  grid: 'FF34D399',
} as const;

/** Sheet name for the fill-in grid, e.g. `4. Enter your seekers`. */
function gridSheetName(participantType: string): string {
  const plural = participantType.endsWith('s') ? participantType : `${participantType}s`;
  const full = `4. Enter your ${plural.replaceAll('_', ' ')}`;
  return full.length <= SHEET_NAME_MAX ? full : '4. Enter your rows';
}

export interface XlsxTemplateOptions {
  /**
   * Delimiter for array-typed cells, from the network's `csv_array_delimiter`.
   * Shown on tab 2 and used in the sample rows, so the workbook documents the
   * delimiter the parser will actually split on.
   */
  arrayDelimiter?: string;
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
  /** Human label from the schema's `title`, falling back to the field name. */
  label: string;
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
    label: typeof prop['title'] === 'string' ? (prop['title'] as string) : name,
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

/**
 * Renders the "only fill in when" sentence for a conditional column.
 *
 * @param plan - The column.
 * @param byName - Every column by field name, for the controller's label.
 * @returns The sentence, or `''` when the column always applies.
 */
function onlyWhen(plan: ColumnPlan, byName: ReadonlyMap<string, ColumnPlan>): string {
  if (plan.showIfField === undefined) return '';
  const controller = byName.get(plan.showIfField)?.label ?? plan.showIfField;
  if (plan.showIfValues.length === 0) return `Only when "${controller}" is filled in`;
  return `Only when "${controller}" is ${plan.showIfValues.join(' or ')}`;
}

/**
 * Lowercases only the first character, so a sentence can be spliced mid-line
 * without also lowercasing a field's human label ("Work Experience").
 *
 * @param text - Sentence to splice.
 * @returns The sentence with a lowercase lead-in.
 */
function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

/**
 * Builds the XLSX bulk-upload template for one participant type.
 *
 * @param schema - Participant JSON Schema (object-typed, draft 2020-12).
 * @param participantType - Domain id, used in the sheet + column naming.
 * @param options - Array delimiter and identity selectors.
 * @returns The workbook as a buffer, ready to send as an attachment.
 */
export async function buildXlsxTemplate(
  schema: JsonSchema,
  participantType: string,
  options: XlsxTemplateOptions = {},
): Promise<Buffer> {
  const { arrayDelimiter = '|', identity } = options;

  const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );
  const plans = orderedColumns(schema).map((name) =>
    planColumn(name, properties[name] ?? {}, required.has(name)),
  );
  const byName = new Map(plans.map((p) => [p.name, p]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Blue Dots Aggregator';
  wb.created = new Date();

  const gridName = gridSheetName(participantType);
  writeInstructions(wb, participantType, plans, byName, gridName, arrayDelimiter);

  const lists = wb.addWorksheet(LISTS_SHEET);
  const ranges = writeLists(lists, plans);
  lists.state = 'veryHidden';

  writeValuesSheet(wb, plans, byName, arrayDelimiter);
  writeSampleSheet(wb, plans, arrayDelimiter, identity);
  writeGridSheet(wb, gridName, plans, byName, ranges, arrayDelimiter);

  // Read-only tabs are locked so a stray keystroke cannot rewrite the guidance
  // an operator is reading. The grid is deliberately left unprotected: locking
  // it would mean unlocking 18,000 data cells to keep paste working, and a
  // paste that silently fails is worse than an edited header.
  for (const name of [INSTRUCTIONS_SHEET, VALUES_SHEET, SAMPLE_SHEET]) {
    await wb.getWorksheet(name)?.protect('', { selectLockedCells: true, formatCells: false });
  }

  // exceljs declares its own `Buffer` interface, structurally unrelated to
  // Node's, so the cast goes through `unknown`. The value IS a Node Buffer.
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

/**
 * Writes tab 1: what to do, plus the legend the other tabs' colours refer to.
 *
 * @param wb - Target workbook.
 * @param participantType - Domain id.
 * @param plans - Column plans.
 * @param byName - Columns by field name.
 * @param gridName - Name of the fill-in sheet, quoted in the steps.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeInstructions(
  wb: ExcelJS.Workbook,
  participantType: string,
  plans: readonly ColumnPlan[],
  byName: ReadonlyMap<string, ColumnPlan>,
  gridName: string,
  arrayDelimiter: string,
): void {
  const sheet = wb.addWorksheet(INSTRUCTIONS_SHEET);
  sheet.properties.tabColor = { argb: TAB_COLOURS.instructions };
  sheet.getColumn(1).width = 4;
  sheet.getColumn(2).width = 112;

  /** Adds a row in the text column, returning it for styling. */
  const line = (text = '', indent = 2): ExcelJS.Row => {
    const row = sheet.addRow(indent === 1 ? [text] : ['', text]);
    row.getCell(indent).alignment = { wrapText: true, vertical: 'top' };
    return row;
  };

  const title = line(`Bulk upload — ${participantType.replaceAll('_', ' ')}`);
  title.font = { bold: true, size: 16 };
  line('Fill this in, save it as CSV, and upload the CSV to the portal.').font = {
    color: { argb: 'FF475569' },
  };
  line();

  line('Steps').font = { bold: true, size: 12 };
  const requiredLabels = plans.filter((p) => p.required).map((p) => `"${p.label}"`);
  for (const step of [
    `1. Open "${SAMPLE_SHEET}" and look at how a row is filled in. Do not type there — it is locked.`,
    `2. Type your own rows in "${gridName}", one participant per row. Start on row 2.`,
    `3. Cells with a dropdown arrow only accept the listed values. Click the arrow and pick one.`,
    `4. Leave anything you do not have blank. Only ${requiredLabels.join(' and ') || 'the marked columns'} must be filled for every row.`,
    `5. Check "${VALUES_SHEET}" whenever you are unsure what a column wants.`,
    `6. Save as CSV: File > Save As (or Export) > CSV. Then upload that .csv file.`,
  ]) {
    line(step);
  }
  line();

  line('What the colours mean').font = { bold: true, size: 12 };
  const legend: Array<[string, string]> = [
    [FILL_REQUIRED, 'Must be filled in for every row.'],
    [FILL_CONDITIONAL, 'Only applies in some cases — the column heading says when. Usually blank.'],
    [FILL_OPTIONAL, 'Optional. Fill it in if you have it; a fuller row matches better.'],
  ];
  for (const [argb, text] of legend) {
    const row = line(text);
    const swatch = row.getCell(1);
    swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    swatch.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  }
  line();

  line('Good to know').font = { bold: true, size: 12 };
  const multi = plans.filter((p) => p.isArray);
  if (multi.length > 0) {
    line(
      `• ${multi.length} column${multi.length === 1 ? '' : 's'} take more than one value. Join them with "${arrayDelimiter}" in the same cell — for example: ${exampleValue(multi[0]!.name, multi[0]!.prop, arrayDelimiter)}`,
    );
  }
  const conditional = plans.filter((p) => p.showIfField !== undefined);
  if (conditional.length > 0) {
    const example = conditional[0]!;
    line(
      `• ${conditional.length} of the ${plans.length} columns only apply in some cases. Example: "${example.label}" — ${lowerFirst(onlyWhen(example, byName))}.`,
    );
  }
  line('• Hover over any column heading for a short explanation of that column.');
  line('• Do not rename, reorder or delete the heading row — the upload matches on it.');
  line('• Row 1 must stay exactly as it is. Your data starts on row 2.');
}

/**
 * Writes one hidden column of allowed values per closed-set field.
 *
 * Every dropdown is range-backed rather than inline, uniformly. Excel caps an
 * inline list at 255 characters and ka-dhwd alone has three fields far past it
 * (`itiTrade` is 170 values / 5,555 characters), so special-casing the long
 * ones would mean two code paths where one is exercised only by the schemas
 * nobody tests with.
 *
 * @param sheet - The hidden lists sheet.
 * @param plans - Column plans.
 * @returns Absolute range formula per column name.
 */
function writeLists(
  sheet: ExcelJS.Worksheet,
  plans: readonly ColumnPlan[],
): ReadonlyMap<string, string> {
  const ranges = new Map<string, string>();
  let col = 1;
  for (const plan of plans) {
    if (plan.allowed.length === 0) continue;
    const letter = columnLetter(col);
    sheet.getCell(1, col).value = plan.name;
    plan.allowed.forEach((value, i) => {
      sheet.getCell(i + 2, col).value = value;
    });
    ranges.set(plan.name, `'${LISTS_SHEET}'!$${letter}$2:$${letter}$${plan.allowed.length + 1}`);
    col += 1;
  }
  return ranges;
}

/**
 * Writes tab 2: one row per column, closed sets first.
 *
 * Row-per-column rather than the reference workbook's column-per-field, so it
 * reads top-to-bottom like a list and stays legible at 40 columns. Closed sets
 * come first because "what am I allowed to type here" is the question this tab
 * exists to answer; the free-text columns follow so the tab is still a complete
 * index of the grid.
 *
 * @param wb - Target workbook.
 * @param plans - Column plans.
 * @param byName - Columns by field name.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeValuesSheet(
  wb: ExcelJS.Workbook,
  plans: readonly ColumnPlan[],
  byName: ReadonlyMap<string, ColumnPlan>,
  arrayDelimiter: string,
): void {
  const sheet = wb.addWorksheet(VALUES_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.properties.tabColor = { argb: TAB_COLOURS.values };
  sheet.columns = [
    { header: 'Column heading in the grid', key: 'name', width: 34 },
    { header: 'What it means', key: 'label', width: 30 },
    { header: 'Must fill?', key: 'required', width: 11 },
    { header: 'More than one?', key: 'multi', width: 16 },
    { header: 'Only fill in when', width: 40, key: 'when' },
    { header: 'Accepted values', key: 'allowed', width: 70 },
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.height = 24;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0EAFF' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });

  const closed = plans.filter((p) => p.allowed.length > 0);
  const free = plans.filter((p) => p.allowed.length === 0);

  /** Adds one column's row, shaded to match the grid's header colour. */
  const addRow = (plan: ColumnPlan): void => {
    const row = sheet.addRow({
      name: plan.name,
      label: plan.label,
      required: plan.required ? 'Yes' : 'No',
      multi: plan.isArray ? `Yes — join with ${arrayDelimiter}` : 'No',
      when: onlyWhen(plan, byName) || 'Always',
      allowed:
        plan.allowed.length > 0
          ? plan.allowed.join(`${arrayDelimiter} `)
          : (plan.description ?? 'Free text'),
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('name').font = { bold: plan.required };
    row.getCell('name').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: headerFill(plan) },
    };
  };

  if (closed.length > 0) {
    const banner = sheet.addRow(['Columns with a dropdown — these accept ONLY the values listed']);
    banner.font = { bold: true, color: { argb: 'FF1D4ED8' } };
    closed.forEach(addRow);
  }
  if (free.length > 0) {
    sheet.addRow([]);
    const banner = sheet.addRow(['Everything else — type freely']);
    banner.font = { bold: true, color: { argb: 'FF475569' } };
    free.forEach(addRow);
  }
}

/**
 * Generates sample rows that demonstrate every conditional branch.
 *
 * One row cannot show that `stipendMin` applies to an Internship while
 * `salaryMin` applies to a Full-time role, and on the live seeker schema 21 of
 * 36 columns are conditional — that asymmetry is most of what an operator gets
 * wrong. So a row is emitted per controller value: the controller is pinned,
 * the fields that value unlocks are filled, and the fields it does not unlock
 * are left blank, which is exactly the shape the schema expects. Values of the
 * remaining closed sets are then rotated across those rows so each appears at
 * least once wherever the row count allows.
 *
 * @param plans - Column plans.
 * @param arrayDelimiter - Delimiter for array cells.
 * @param identity - Identity selectors, for realistic phone/email cells.
 * @returns Rows as arrays positionally aligned to `plans`.
 */
function sampleRows(
  plans: readonly ColumnPlan[],
  arrayDelimiter: string,
  identity?: XlsxTemplateOptions['identity'],
): string[][] {
  const controllers = new Map<string, string[]>();
  for (const plan of plans) {
    if (plan.showIfField === undefined || controllers.has(plan.showIfField)) continue;
    const controller = plans.find((p) => p.name === plan.showIfField);
    if (controller && controller.allowed.length > 0) {
      controllers.set(plan.showIfField, controller.allowed);
    }
  }

  /** One cell, given the controller values pinned for this row. */
  const cell = (plan: ColumnPlan, pins: Map<string, string>, rowIndex: number): string => {
    const pinned = pins.get(plan.name);
    if (pinned !== undefined) return pinned;

    if (plan.showIfField !== undefined) {
      const controllerValue = pins.get(plan.showIfField);
      // Blank unless this row's controller value actually unlocks the field —
      // a filled-in conditional that does not apply is the wrong example.
      if (controllerValue === undefined) return '';
      if (plan.showIfValues.length > 0 && !plan.showIfValues.includes(controllerValue)) return '';
    }
    // Per-row identity values, so the rows read as distinct people rather than
    // fourteen copies of one. Config names these columns, nothing is guessed.
    if (identity !== undefined) {
      if (plan.name === identity.name) return `Sample Person ${rowIndex + 1}`;
      if (plan.name === identity.phone) return `98765${String(10000 + rowIndex).slice(-5)}`;
      if (plan.name === identity.email) return `person${rowIndex + 1}@example.com`;
    }
    // Rotate a closed set's values across rows so each is demonstrated
    // somewhere, rather than every row repeating the first option.
    if (plan.allowed.length > 1 && !controllers.has(plan.name)) {
      return plan.allowed[rowIndex % plan.allowed.length] as string;
    }
    return exampleValue(plan.name, plan.prop, arrayDelimiter);
  };

  const pinSets: Array<Map<string, string>> = [];
  for (const [field, values] of controllers) {
    for (const value of values) {
      if (pinSets.length >= MAX_SAMPLE_ROWS) break;
      pinSets.push(new Map([[field, value]]));
    }
    if (pinSets.length >= MAX_SAMPLE_ROWS) break;
  }
  // A schema with no conditionals still deserves worked examples.
  if (pinSets.length === 0) pinSets.push(new Map(), new Map());

  // Drop pin sets that would render the same row twice. Pinning controller A
  // leaves controller B at its first value, so the row pinning B's first value
  // is a duplicate of the row pinning A's first value — a wasted line in a
  // sheet whose whole job is showing DIFFERENT cases. The signature ignores the
  // identity columns because those vary by row index by construction and would
  // make every row look unique.
  const identityColumns = new Set(
    identity === undefined ? [] : [identity.name, identity.phone, identity.email],
  );
  const signature = (pins: Map<string, string>): string =>
    plans
      .filter((plan) => !identityColumns.has(plan.name))
      .map((plan) => cell(plan, pins, 0))
      .join('');

  const seen = new Set<string>();
  const distinct = pinSets.filter((pins) => {
    const key = signature(pins);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return distinct.map((pins, i) => plans.map((plan) => cell(plan, pins, i)));
}

/**
 * Writes tab 3: the worked examples, with the same header as the grid so a row
 * can be copied straight across.
 *
 * @param wb - Target workbook.
 * @param plans - Column plans.
 * @param arrayDelimiter - Delimiter for array cells.
 * @param identity - Identity selectors.
 */
function writeSampleSheet(
  wb: ExcelJS.Workbook,
  plans: readonly ColumnPlan[],
  arrayDelimiter: string,
  identity?: XlsxTemplateOptions['identity'],
): void {
  const sheet = wb.addWorksheet(SAMPLE_SHEET, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
  });
  sheet.properties.tabColor = { argb: TAB_COLOURS.sample };
  applyColumns(sheet, plans);
  styleHeader(sheet, plans);

  for (const row of sampleRows(plans, arrayDelimiter, identity)) {
    sheet.addRow(row).font = { color: { argb: 'FF475569' }, italic: true };
  }
}

/**
 * Writes tab 4: the empty grid, with the dropdowns.
 *
 * Header row only above the data — no label row, no merged banner. The
 * exported CSV's first line has to be the header the parser matches on, so
 * anything else above the data would be uploaded as a row and fail.
 *
 * @param wb - Target workbook.
 * @param name - Sheet name.
 * @param plans - Column plans.
 * @param byName - Columns by field name.
 * @param ranges - Range formula per closed-set column.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeGridSheet(
  wb: ExcelJS.Workbook,
  name: string,
  plans: readonly ColumnPlan[],
  byName: ReadonlyMap<string, ColumnPlan>,
  ranges: ReadonlyMap<string, string>,
  arrayDelimiter: string,
): void {
  const sheet = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  sheet.properties.tabColor = { argb: TAB_COLOURS.grid };
  applyColumns(sheet, plans);
  styleHeader(sheet, plans, { byName, arrayDelimiter });

  plans.forEach((plan, i) => {
    const range = ranges.get(plan.name);
    if (range === undefined) return;
    // An array column takes several values in one delimiter-joined cell, so a
    // single-value dropdown would reject valid input. Its allowed values are on
    // tab 2 and in the header note instead.
    if (plan.isArray) return;

    for (let row = 2; row <= VALIDATED_ROWS; row += 1) {
      sheet.getCell(row, i + 1).dataValidation = {
        type: 'list',
        allowBlank: !plan.required,
        formulae: [range],
        showErrorMessage: true,
        errorStyle: 'error',
        errorTitle: `Pick a listed value for ${plan.label}`,
        error: `"${plan.label}" only accepts the values in the dropdown. Click the arrow in this cell, or see "${VALUES_SHEET}".`,
      };
    }
  });
}

/**
 * Lays out one column per planned field, in the CSV template's order.
 *
 * Width comes from the human label rather than the field name: the label is
 * what the header note and tab 2 show, and it is the better guide to how wide
 * the typed values will be.
 *
 * @param sheet - Sheet to lay out.
 * @param plans - Column plans.
 */
function applyColumns(sheet: ExcelJS.Worksheet, plans: readonly ColumnPlan[]): void {
  sheet.columns = plans.map((plan) => ({
    header: plan.name,
    key: plan.name,
    width: Math.min(32, Math.max(16, plan.label.length + 2)),
  }));
}

/** Header fill for a column, per the legend on tab 1. */
function headerFill(plan: ColumnPlan): string {
  if (plan.required) return FILL_REQUIRED;
  return plan.showIfField !== undefined ? FILL_CONDITIONAL : FILL_OPTIONAL;
}

/**
 * Applies the shared header styling, and per-column notes on the grid.
 *
 * @param sheet - Sheet whose row 1 is the header.
 * @param plans - Column plans.
 * @param notes - When given, attach a hover note to each header cell.
 */
function styleHeader(
  sheet: ExcelJS.Worksheet,
  plans: readonly ColumnPlan[],
  notes?: { byName: ReadonlyMap<string, ColumnPlan>; arrayDelimiter: string },
): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, size: 11 };
  header.height = 30;
  header.alignment = { vertical: 'middle', wrapText: true };

  plans.forEach((plan, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerFill(plan) } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    if (notes) cell.note = headerNote(plan, notes.byName, notes.arrayDelimiter);
  });
}

/**
 * Builds the note attached to a header cell — the label, whether it is
 * required, when it applies, and what it accepts, without leaving the cell.
 *
 * @param plan - The column.
 * @param byName - Columns by field name, for the controller's label.
 * @param arrayDelimiter - Delimiter for array cells.
 * @returns Note text.
 */
function headerNote(
  plan: ColumnPlan,
  byName: ReadonlyMap<string, ColumnPlan>,
  arrayDelimiter: string,
): string {
  const lines = [`${plan.label}${plan.required ? ' — must be filled in' : ' — optional'}`];
  if (plan.description !== undefined) lines.push(plan.description);
  const when = onlyWhen(plan, byName);
  if (when) lines.push(`${when}. Otherwise leave blank.`);
  if (plan.isArray) lines.push(`More than one value allowed — join them with "${arrayDelimiter}".`);
  if (plan.allowed.length > 0) {
    lines.push(
      plan.allowed.length <= 10
        ? `Pick one of: ${plan.allowed.join(', ')}`
        : `${plan.allowed.length} values to choose from — use the dropdown, or see "${VALUES_SHEET}".`,
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
