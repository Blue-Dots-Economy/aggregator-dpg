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
/** Tab 3 — worked examples. */
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
  /**
   * Parsed `x-show-if` clauses — one per controller field, ANDed together, in
   * the rule's own key order. Empty when the column always applies.
   */
  showIf: readonly ShowIfClause[];
  /**
   * True when the rule is present but cannot be satisfied by any form state,
   * so the column is never shown. See {@link parseShowIf}.
   */
  showIfNeverApplies: boolean;
  description?: string;
}

/** One `(controller field → values that reveal this column)` clause. */
interface ShowIfClause {
  field: string;
  /** Controller values that make the column apply; empty means "any value". */
  values: string[];
}

/**
 * True when a column does not apply to every row.
 *
 * @param plan - The column.
 * @returns `true` when the column is conditional in any way.
 */
function isConditional(plan: ColumnPlan): boolean {
  return plan.showIf.length > 0 || plan.showIfNeverApplies;
}

/**
 * Parses the custom `x-show-if` keyword the same way the form renderer does.
 *
 * Deliberately mirrors `apps/web/src/lib/show-if.ts` (`isFieldVisible`), which
 * is the implementation that decides what an operator actually sees: **every**
 * `(controlField → allowed)` entry must hold (AND across keys), and a
 * non-array `allowed` makes the field permanently hidden rather than
 * unconstrained. Reading only the first key described a weaker condition than
 * the form enforces, and treating a scalar as "no constraint" said "always
 * fill this in" about a column the form never shows.
 *
 * Every `x-show-if` in `config/` is single-key and array-valued today, so this
 * is parity insurance rather than a live divergence — but the workbook is the
 * document an operator trusts over the form, so the two must not be able to
 * disagree.
 *
 * Known limitation, shared with the form renderer: conditionality expressed
 * the plain JSON Schema way (`allOf` / `if` / `then`) is not read here, and a
 * network using it would get every column marked optional. `x-show-if` is the
 * only conditional keyword either side supports today; adding a fallback here
 * alone would make the workbook and the form disagree in the other direction.
 *
 * @param rule - The property's `x-show-if` value, whatever shape it has.
 * @returns The ANDed clauses, and whether the rule can ever be satisfied.
 */
function parseShowIf(rule: unknown): { clauses: ShowIfClause[]; neverApplies: boolean } {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return { clauses: [], neverApplies: false };
  }
  const clauses: ShowIfClause[] = [];
  for (const [field, allowed] of Object.entries(rule as Record<string, unknown>)) {
    // `isFieldVisible` returns false outright for a non-array `allowed`.
    if (!Array.isArray(allowed)) return { clauses: [], neverApplies: true };
    clauses.push({ field, values: allowed.map(String) });
  }
  return { clauses, neverApplies: false };
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
  const showIf = parseShowIf(prop['x-show-if']);

  const plan: ColumnPlan = {
    name,
    prop,
    label: typeof prop['title'] === 'string' ? (prop['title'] as string) : name,
    required,
    allowed: (ownEnum ?? itemEnum ?? []).map(String),
    isArray: prop['type'] === 'array',
    showIf: showIf.clauses,
    showIfNeverApplies: showIf.neverApplies,
  };

  if (typeof prop['description'] === 'string') plan.description = prop['description'] as string;
  return plan;
}

/**
 * Renders the "only fill in when" sentence for a conditional column.
 *
 * Multi-clause rules are joined with "and", matching the AND the form renderer
 * applies — a sentence that named only the first controller would describe a
 * weaker condition than the one actually enforced.
 *
 * @param plan - The column.
 * @param byName - Every column by field name, for the controller's label.
 * @returns The sentence, or `''` when the column always applies.
 */
function onlyWhen(plan: ColumnPlan, byName: ReadonlyMap<string, ColumnPlan>): string {
  if (plan.showIfNeverApplies) return 'Never — leave this blank';
  if (plan.showIf.length === 0) return '';
  const clause = ({ field, values }: ShowIfClause): string => {
    const controller = byName.get(field)?.label ?? field;
    return values.length === 0
      ? `"${controller}" is filled in`
      : `"${controller}" is ${values.join(' or ')}`;
  };
  return `Only when ${plan.showIf.map(clause).join(' and ')}`;
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

  // Open on the grid, not on tab 1. "File > Save As > CSV" exports the ACTIVE
  // sheet, so a workbook that opens on Instructions hands an operator who saves
  // straight away a CSV of the instructions — which then fails the upload on a
  // header mismatch. Found by actually round-tripping the file through a
  // spreadsheet app rather than assuming.
  wb.views = [
    {
      activeTab: wb.worksheets.findIndex((sheet) => sheet.name === gridName),
      firstSheet: 0,
      visibility: 'visible',
      x: 0,
      y: 0,
      width: 28000,
      height: 18000,
    },
  ];

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
    `1. Open "${SAMPLE_SHEET}" and look at how a row is filled in. It is only an example — nothing there is uploaded.`,
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
  const conditional = plans.filter(isConditional);
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
      // Comma-separated unless the column really does take several values: on a
      // single-value column the delimiter reads as an instruction to join them,
      // which is the one thing that column does not accept.
      allowed:
        plan.allowed.length > 0
          ? plan.allowed.join(plan.isArray ? `${arrayDelimiter} ` : ', ')
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
 * Blank for a conditional column this row's controller value does not unlock.
 *
 * A filled-in conditional that does not apply is the wrong example — it teaches
 * an operator to populate a column the schema will reject.
 *
 * @param plan - The column.
 * @param pins - Controller values fixed for this row.
 * @returns `''` when the column does not apply, else undefined to fall through.
 */
function conditionalCell(plan: ColumnPlan, pins: ReadonlyMap<string, string>): string | undefined {
  if (plan.showIfNeverApplies) return '';
  if (plan.showIf.length === 0) return undefined;
  // AND across clauses, as `isFieldVisible` does — a row that pins only one
  // controller of a two-key rule leaves the column blank, because that is what
  // the form would show.
  const applies = plan.showIf.every(({ field, values }) => {
    const pinned = pins.get(field);
    if (pinned === undefined) return false;
    return values.length === 0 || values.includes(pinned);
  });
  return applies ? undefined : '';
}

/**
 * True when a candidate identity value satisfies the column's own declaration.
 *
 * The column's schema outranks any identity-shaped placeholder: a value that
 * fails the column's `format` or `pattern` is one the row parser rejects, and
 * `bulk-row-process` treats both as blocking. When this returns `false` the
 * caller falls through to `exampleValue`, which derives from the declaration
 * rather than around it.
 *
 * @param plan - The column.
 * @param candidate - The identity value being considered for the cell.
 * @param satisfiesFormat - The one `format` this candidate is known to meet,
 *   or undefined when it meets none.
 * @returns `true` when the candidate can be used as-is.
 */
function fitsColumn(plan: ColumnPlan, candidate: string, satisfiesFormat?: string): boolean {
  const format = plan.prop['format'];
  if (typeof format === 'string' && format !== satisfiesFormat) return false;

  const pattern = plan.prop['pattern'];
  if (typeof pattern !== 'string') return true;
  try {
    return new RegExp(pattern).test(candidate);
  } catch {
    return false;
  }
}

/**
 * Per-row name / phone / email, so the sample rows read as distinct entries
 * rather than a dozen copies of one.
 *
 * Config names these columns (`ResolvedDomain.identity`); nothing is guessed
 * from field names.
 *
 * Two things this deliberately does NOT do:
 *
 * - **Override a column that declares its own `format` or `pattern`.** A phone
 *   declaring `^\+91[0-9]{10}$` or `^[0-9]{12}$` would reject the hardcoded
 *   10-digit run, putting a value the row parser rejects in the field the
 *   network dedups on — and making the workbook and the CSV template disagree
 *   about the same column. `exampleValue` handles those; this only fills the
 *   gap where the schema says nothing about the shape.
 * - **Assume `identity.name` names a person.** blue_dot points it at
 *   `jobProviderName` (`config/blue_dot/aggregator.config.yaml`), so the
 *   sample is built from the column's own label — "Sample Job Provider Name 1"
 *   rather than "Sample Person 1" in a company-name column.
 *
 * @param plan - The column.
 * @param rowIndex - Zero-based sample row index.
 * @param identity - The domain's identity selectors, when configured.
 * @returns The cell value, or undefined when this is not an identity column.
 */
function identityCell(
  plan: ColumnPlan,
  rowIndex: number,
  identity?: XlsxTemplateOptions['identity'],
): string | undefined {
  if (identity === undefined) return undefined;

  const candidate =
    plan.name === identity.name
      ? { value: `Sample ${plan.label} ${rowIndex + 1}`, format: undefined }
      : plan.name === identity.phone
        ? { value: `98765${String(10000 + rowIndex).slice(-5)}`, format: undefined }
        : plan.name === identity.email
          ? { value: `person${rowIndex + 1}@example.com`, format: 'email' }
          : undefined;
  if (candidate === undefined) return undefined;

  return fitsColumn(plan, candidate.value, candidate.format) ? candidate.value : undefined;
}

/**
 * Next value of a closed set, rotated by row, so each is demonstrated somewhere
 * rather than every row repeating the first option.
 *
 * Two kinds of column are excluded:
 *
 * - **Controllers** — their value is pinned per row to drive the conditional
 *   branches, which is a stronger claim on the cell than rotation.
 * - **Array columns** — `planColumn` fills `allowed` from `items.enum` too, so
 *   a multi-value column would otherwise rotate to ONE value per cell and tab
 *   3 would never show the delimiter. Falling through to `exampleValue` is the
 *   only thing that produces a joined cell, and the join is the single
 *   formatting rule a CSV cannot express — precisely what the tab the operator
 *   copies from has to demonstrate.
 *
 * @param plan - The column.
 * @param rowIndex - Zero-based sample row index.
 * @param controllers - Columns that other columns are conditional on.
 * @returns The rotated value, or undefined when rotation does not apply.
 */
function rotatedCell(
  plan: ColumnPlan,
  rowIndex: number,
  controllers: ReadonlyMap<string, string[]>,
): string | undefined {
  if (plan.allowed.length <= 1 || plan.isArray || controllers.has(plan.name)) return undefined;
  return plan.allowed[rowIndex % plan.allowed.length];
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
  const controllers = collectControllers(plans);

  /** One cell, given the controller values pinned for this row. */
  const cell = (plan: ColumnPlan, pins: ReadonlyMap<string, string>, rowIndex: number): string =>
    pins.get(plan.name) ??
    conditionalCell(plan, pins) ??
    identityCell(plan, rowIndex, identity) ??
    rotatedCell(plan, rowIndex, controllers) ??
    exampleValue(plan.name, plan.prop, arrayDelimiter);

  // The signature ignores the identity columns: those vary by row index by
  // construction, so including them would make every row look unique and the
  // duplicate filter would never fire.
  const identityColumns = new Set(
    identity === undefined ? [] : [identity.name, identity.phone, identity.email],
  );
  const signature = (pins: ReadonlyMap<string, string>): string =>
    plans
      .filter((plan) => !identityColumns.has(plan.name))
      .map((plan) => cell(plan, pins, 0))
      .join('');

  const distinct = dedupeBy(buildPinSets(controllers), signature);
  return distinct.map((pins, i) => plans.map((plan) => cell(plan, pins, i)));
}

/**
 * Maps each controller field to its allowed values.
 *
 * A controller is a column that other columns declare `x-show-if` against, and
 * only one with a closed set can drive sample rows — there is nothing to
 * enumerate otherwise.
 *
 * @param plans - Column plans.
 * @returns Controller field name to its allowed values.
 */
function collectControllers(plans: readonly ColumnPlan[]): ReadonlyMap<string, string[]> {
  const controllers = new Map<string, string[]>();
  for (const plan of plans) {
    for (const { field } of plan.showIf) {
      if (controllers.has(field)) continue;
      const controller = plans.find((p) => p.name === field);
      if (controller && controller.allowed.length > 0) {
        controllers.set(field, controller.allowed);
      }
    }
  }
  return controllers;
}

/**
 * One pin set per controller value — the shape of the sample sheet.
 *
 * Each pin set fixes a single controller to a single value, so the row it
 * renders demonstrates exactly one conditional branch. Capped at
 * {@link MAX_SAMPLE_ROWS}: on a wide schema the product of every controller and
 * value runs to dozens of rows, and a sample sheet nobody scrolls to the end of
 * teaches nothing.
 *
 * @param controllers - Controller fields and their allowed values.
 * @returns Pin sets, in controller declaration order.
 */
function buildPinSets(
  controllers: ReadonlyMap<string, string[]>,
): Array<ReadonlyMap<string, string>> {
  const pinSets: Array<ReadonlyMap<string, string>> = [];
  for (const [field, values] of controllers) {
    for (const value of values) {
      if (pinSets.length >= MAX_SAMPLE_ROWS) return pinSets;
      pinSets.push(new Map([[field, value]]));
    }
  }
  // A schema with no conditionals still deserves worked examples.
  return pinSets.length > 0 ? pinSets : [new Map(), new Map()];
}

/**
 * Drops entries whose key repeats one already seen, keeping the first.
 *
 * Pinning controller A leaves controller B at its first value, so the row
 * pinning B's first value renders identically to the row pinning A's — a wasted
 * line in a sheet whose whole job is showing DIFFERENT cases.
 *
 * @param items - Items in the order they should be kept.
 * @param key - Derives the comparison key for an item.
 * @returns The items with later duplicates removed.
 */
function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

    // Added against the RANGE, not cell by cell. Assigning `dataValidation` on
    // `getCell(row, col)` materialises that cell, and with 499 rows x every
    // closed-set column that left the sheet declaring
    // `<dimension ref="A1:AJ500">` with 499 empty `<row>` records. They export
    // as nothing in LibreOffice, but "used range" is a per-application
    // judgement and the failure mode if an application disagrees is ugly and
    // silent: the operator types 2 rows, Save As writes 500 lines, and the
    // upload reports 498 failures they cannot explain. The XLSX format stores
    // list validations by `sqref` range anyway, so addressing the range is both
    // the smaller file and the one with no phantom rows.
    const letter = columnLetter(i + 1);
    rangeValidations(sheet).add(`${letter}2:${letter}${VALIDATED_ROWS}`, {
      type: 'list',
      allowBlank: !plan.required,
      formulae: [range],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: `Pick a listed value for ${plan.label}`,
      error: `"${plan.label}" only accepts the values in the dropdown. Click the arrow in this cell, or see "${VALUES_SHEET}".`,
    });
  });
}

/**
 * Range-addressable view of a sheet's data validations.
 *
 * exceljs keeps `worksheet.dataValidations` at runtime (`lib/doc/data-validations.js`)
 * but leaves it out of its published typings — `index.d.ts` exposes only the
 * per-cell `dataValidation` and has the worksheet-level model commented out. The
 * cast is deliberate rather than incidental, and the workbook test asserts both
 * halves of what it buys: that the emitted `sqref` ranges are present, and that
 * the sheet declares no phantom rows. An exceljs upgrade that moved this would
 * fail those assertions instead of silently shipping a workbook with no
 * dropdowns.
 *
 * @param sheet - Sheet to add range validations to.
 * @returns The sheet's validation collection.
 */
function rangeValidations(sheet: ExcelJS.Worksheet): {
  add: (address: string, validation: ExcelJS.DataValidation) => void;
} {
  return (
    sheet as unknown as {
      dataValidations: { add: (address: string, validation: ExcelJS.DataValidation) => void };
    }
  ).dataValidations;
}

/**
 * Number format for a column, so Excel does not rewrite what the operator types.
 *
 * Left on the default General format, Excel reinterprets the cell and **Save As
 * CSV writes the DISPLAYED value, not the typed one** — which is the same
 * post-hoc `errors.csv` failure this generator exists to remove, reintroduced
 * by cell formatting:
 *
 * - a `format: date` column typed as `2024-01-01` exports per locale as
 *   `01/01/2024`, which `ajv-formats` (registered in
 *   `packages/schema-loader/src/ajv.ts`) rejects;
 * - a leading zero is dropped, so a pincode or an ID loses a digit;
 * - a long numeric id flips to scientific notation.
 *
 * Text (`@`) is therefore the default: it makes the exported CSV byte-identical
 * to what was typed for every column. Date columns get an explicit ISO mask
 * instead, so a value Excel has already parsed as a date still round-trips in
 * the shape `formatExample` demonstrates.
 *
 * @param plan - The column.
 * @returns The Excel number-format code for the column's cells.
 */
function numFmtFor(plan: ColumnPlan): string {
  return plan.prop['format'] === 'date' ? 'yyyy-mm-dd' : '@';
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
    style: { numFmt: numFmtFor(plan) },
  }));
}

/** Header fill for a column, per the legend on tab 1. */
function headerFill(plan: ColumnPlan): string {
  if (plan.required) return FILL_REQUIRED;
  return isConditional(plan) ? FILL_CONDITIONAL : FILL_OPTIONAL;
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

  // One sentence about multiplicity, not two: an array column with a closed set
  // used to get "join them with |" AND "Pick one of: …", which contradict each
  // other about the same cell.
  const pick = plan.isArray ? 'Pick one or more of' : 'Pick one of';
  if (plan.allowed.length > 0) {
    lines.push(
      plan.allowed.length <= 10
        ? `${pick}: ${plan.allowed.join(', ')}${plan.isArray ? ` — join them with "${arrayDelimiter}".` : ''}`
        : `${plan.allowed.length} values to choose from — use the dropdown, or see "${VALUES_SHEET}".${plan.isArray ? ` More than one is allowed — join them with "${arrayDelimiter}".` : ''}`,
    );
  } else if (plan.isArray) {
    lines.push(`More than one value allowed — join them with "${arrayDelimiter}".`);
  }
  return lines.join('\n');
}

/** 1-based column index to its spreadsheet letter (1 becomes A, 27 becomes AA). */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCodePoint(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
