import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildXlsxTemplate, columnLetter } from '../index.js';
import { buildCsvTemplate, orderedColumns } from '../../csv-template/index.js';

/**
 * Mirrors the shapes the real networks use, including the three that constrain
 * the design: a closed set far past Excel's 255-character inline-list cap
 * (ka-dhwd's `itiTrade` is 170 values / 5,555 chars), an array column whose
 * cell holds several delimiter-joined values, and `x-show-if` conditionals —
 * which on the live seeker schema are 21 of 36 columns.
 */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'phone'],
  properties: {
    name: { type: 'string', title: 'Full Name', minLength: 1 },
    phone: { type: 'string', title: 'Mobile Number', pattern: '^[0-9]{10}$' },
    email: { type: 'string', title: 'Email', format: 'email' },
    age: { type: 'integer', title: 'Age', minimum: 14, maximum: 65 },
    gender: { type: 'string', title: 'Gender', enum: ['Male', 'Female', 'Other'] },
    workExperience: {
      type: 'string',
      title: 'Work Experience',
      enum: ['Fresher', 'Worked before'],
    },
    lastRole: {
      type: 'string',
      title: 'Last Role Held',
      'x-show-if': { workExperience: ['Worked before'] },
    },
    languageSpoken: {
      type: 'array',
      title: 'Languages Spoken',
      items: { enum: ['Hindi', 'English', 'Kannada'] },
    },
    // 300 values: nowhere near an inline list, so it must resolve via a range.
    itiTrade: {
      type: 'string',
      title: 'ITI Trade',
      enum: Array.from({ length: 300 }, (_, i) => `Trade ${i + 1}`),
    },
    notes: { type: 'string', title: 'Notes', description: 'Anything else worth knowing' },
  },
} as Record<string, unknown>;

const IDENTITY = { name: 'name', phone: 'phone', email: 'email' };

const TAB_INSTRUCTIONS = '1. Instructions';
const TAB_VALUES = '2. Allowed values';
const TAB_SAMPLE = '3. Sample data';
const TAB_GRID = '4. Enter your seekers';

/** Builds the seeker workbook these cases assert against. */
async function build(delimiter = '|'): Promise<ExcelJS.Workbook> {
  const buffer = await buildXlsxTemplate(SCHEMA, 'seeker', {
    arrayDelimiter: delimiter,
    identity: IDENTITY,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

/** All text in column 1 of a sheet, joined — for asserting on prose. */
function textOf(sheet: ExcelJS.Worksheet, column = 2): string {
  const lines: string[] = [];
  sheet.eachRow((row) => lines.push(String(row.getCell(column).value ?? '')));
  return lines.join('\n');
}

/** Row 1 of a sheet as strings. */
function header(sheet: ExcelJS.Worksheet, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    String(sheet.getRow(1).getCell(i + 1).value ?? ''),
  );
}

describe('buildXlsxTemplate', () => {
  it('produces the four operator-facing tabs, in order, plus the hidden lists', async () => {
    const wb = await build();
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      TAB_INSTRUCTIONS,
      'Lists',
      TAB_VALUES,
      TAB_SAMPLE,
      TAB_GRID,
    ]);
  });

  it('names the grid tab after the participant type', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildXlsxTemplate(SCHEMA, 'provider')) as unknown as ExcelJS.Buffer);
    expect(wb.getWorksheet('4. Enter your providers')).toBeDefined();
  });

  it('keeps a grid name with an underscored, long type inside Excel 31-char cap', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildXlsxTemplate(SCHEMA, 'service_provider')) as unknown as ExcelJS.Buffer,
    );
    const grid = wb.worksheets.find((s) => s.name.startsWith('4.'))!;
    expect(grid.name.length).toBeLessThanOrEqual(31);
    expect(grid.name).toBe('4. Enter your service providers');
  });

  // ── The grid must stay exactly parser-shaped ─────────────────────────────

  it('uses the SAME columns in the same order as the CSV template', async () => {
    // The operator exports this sheet to CSV and uploads it, so a divergence
    // here produces a file the parser rejects.
    const wb = await build();
    const expected = orderedColumns(SCHEMA);
    const grid = wb.getWorksheet(TAB_GRID)!;

    expect(header(grid, expected.length)).toEqual(expected);
    expect(header(grid, expected.length).join(',')).toBe(
      buildCsvTemplate(SCHEMA, { exampleRow: false }).trimEnd(),
    );
  });

  it('puts NOTHING above the header row, so the exported CSV parses', async () => {
    // A label row or a merged section banner would leave an extra line in the
    // exported CSV and fail the upload. Row 1 is the machine names; row 2 is
    // where the operator's data starts.
    const wb = await build();
    const grid = wb.getWorksheet(TAB_GRID)!;
    expect(String(grid.getRow(1).getCell(1).value)).toBe('name');
    expect(grid.getRow(1).getCell(1).isMerged).toBe(false);

    const firstDataRow = orderedColumns(SCHEMA).map((_, i) => grid.getCell(2, i + 1).value);
    expect(firstDataRow.every((v) => v === null || v === undefined)).toBe(true);
  });

  it('has no autofilter on the grid — it is noise on an empty sheet', async () => {
    const wb = await build();
    expect(wb.getWorksheet(TAB_GRID)!.autoFilter).toBeFalsy();
  });

  // ── Dropdowns ────────────────────────────────────────────────────────────

  it('attaches a range-backed list validation to every single-value closed set', async () => {
    const wb = await build();
    const grid = wb.getWorksheet(TAB_GRID)!;
    const validation = grid.getCell(2, orderedColumns(SCHEMA).indexOf('gender') + 1).dataValidation;

    expect(validation?.type).toBe('list');
    // A range, never an inline list — Excel caps inline lists at 255 chars and
    // `itiTrade` is far past it, so the mechanism has to be uniform.
    expect(validation?.formulae?.[0]).toContain("'Lists'!$");
    // The error message names the column in words the operator recognises.
    expect(validation?.errorTitle).toContain('Gender');
    expect(validation?.error).toContain(TAB_VALUES);
  });

  it('backs a 300-value set with a range rather than an inline list', async () => {
    const wb = await build();
    const col = orderedColumns(SCHEMA).indexOf('itiTrade') + 1;
    const formula = wb.getWorksheet(TAB_GRID)!.getCell(2, col).dataValidation?.formulae?.[0] as
      string | undefined;

    expect(formula).toMatch(/'Lists'!\$[A-Z]+\$2:\$[A-Z]+\$301/);
    expect((formula ?? '').length).toBeLessThan(255);
  });

  it('leaves array columns without a dropdown, since one cell holds many values', async () => {
    const wb = await build();
    const col = orderedColumns(SCHEMA).indexOf('languageSpoken') + 1;
    // A single-value dropdown would reject the valid `Hindi|English`.
    expect(wb.getWorksheet(TAB_GRID)!.getCell(2, col).dataValidation).toBeUndefined();
  });

  it('hides the lists sheet so its values cannot be edited into the schema', async () => {
    const wb = await build();
    expect(wb.getWorksheet('Lists')!.state).toBe('veryHidden');
  });

  // ── Guidance an operator can act on ──────────────────────────────────────

  it('carries the human label, requiredness and conditionality in each header note', async () => {
    const wb = await build();
    const grid = wb.getWorksheet(TAB_GRID)!;
    const cols = orderedColumns(SCHEMA);
    const noteOf = (name: string): string => {
      const note = grid.getRow(1).getCell(cols.indexOf(name) + 1).note;
      return typeof note === 'string' ? note : JSON.stringify(note);
    };

    expect(noteOf('name')).toContain('Full Name');
    expect(noteOf('name')).toContain('must be filled in');
    expect(noteOf('age')).toContain('optional');
    // The conditional note names the CONTROLLER BY LABEL, not by field name —
    // "Work Experience", not "workExperience".
    expect(noteOf('lastRole')).toContain('Work Experience');
    expect(noteOf('lastRole')).toContain('Worked before');
    expect(noteOf('languageSpoken')).toContain('join them with "|"');
    expect(noteOf('notes')).toContain('Anything else worth knowing');
    // A 300-value set points at the tab instead of listing them in a tooltip.
    expect(noteOf('itiTrade')).toContain('300 values');
  });

  it('colour-codes the header by required / conditional / optional', async () => {
    const wb = await build();
    const grid = wb.getWorksheet(TAB_GRID)!;
    const cols = orderedColumns(SCHEMA);
    const fillOf = (name: string): string =>
      (grid.getRow(1).getCell(cols.indexOf(name) + 1).fill as ExcelJS.FillPattern).fgColor
        ?.argb as string;

    const required = fillOf('name');
    const conditional = fillOf('lastRole');
    const optional = fillOf('age');
    expect(new Set([required, conditional, optional]).size).toBe(3);
    // And the legend on tab 1 uses those same three fills, or it explains
    // nothing.
    const legend = wb.getWorksheet(TAB_INSTRUCTIONS)!;
    const swatches: string[] = [];
    legend.eachRow((row) => {
      const fill = row.getCell(1).fill as ExcelJS.FillPattern | undefined;
      const argb = fill?.fgColor?.argb;
      if (argb) swatches.push(argb);
    });
    expect(swatches).toEqual(expect.arrayContaining([required, conditional, optional]));
  });

  it('tells the operator which sheet to fill and how to save it', async () => {
    const wb = await build();
    const text = textOf(wb.getWorksheet(TAB_INSTRUCTIONS)!);

    expect(text).toContain(TAB_GRID);
    expect(text).toContain(TAB_SAMPLE);
    expect(text).toContain(TAB_VALUES);
    expect(text).toContain('CSV');
    // The two required columns are named by label, so "what must I fill" is
    // answered without reading 10 columns of headers.
    expect(text).toContain('"Full Name"');
    expect(text).toContain('"Mobile Number"');
    // Counts the conditional columns rather than leaving them to be discovered.
    expect(text).toMatch(/1 of the 10 columns only appl/);
  });

  it('lists closed sets first on the allowed-values tab, with labels', async () => {
    const wb = await build();
    const sheet = wb.getWorksheet(TAB_VALUES)!;
    const rows: string[][] = [];
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      rows.push([1, 2, 3, 4, 5, 6].map((c) => String(row.getCell(c).value ?? '')));
    });

    const banner = rows.findIndex((r) => r[0]?.includes('dropdown'));
    const freeBanner = rows.findIndex((r) => r[0]?.includes('type freely'));
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(freeBanner).toBeGreaterThan(banner);

    const byName = new Map(rows.map((r) => [r[0], r]));
    expect(byName.get('gender')?.[1]).toBe('Gender');
    expect(byName.get('gender')?.[5]).toContain('Male');
    expect(byName.get('name')?.[2]).toBe('Yes');
    expect(byName.get('age')?.[2]).toBe('No');
    expect(byName.get('languageSpoken')?.[3]).toContain('|');
    expect(byName.get('lastRole')?.[4]).toContain('Work Experience');
    expect(byName.get('age')?.[4]).toBe('Always');
    // Free-text columns fall back to their description.
    expect(byName.get('notes')?.[5]).toBe('Anything else worth knowing');
    // Every column appears exactly once, so the tab is a complete index. The
    // two banner rows are not columns, so match against the schema's own list
    // rather than counting rows.
    const cols = new Set(orderedColumns(SCHEMA));
    const listed = rows.map((r) => r[0]).filter((n): n is string => n !== undefined && cols.has(n));
    expect(listed).toHaveLength(cols.size);
    expect(new Set(listed).size).toBe(cols.size);
  });

  // ── Sample rows ──────────────────────────────────────────────────────────

  it('gives the sample sheet the same header as the grid, so rows copy across', async () => {
    const wb = await build();
    const cols = orderedColumns(SCHEMA);
    expect(header(wb.getWorksheet(TAB_SAMPLE)!, cols.length)).toEqual(cols);
  });

  it('emits a sample row per conditional branch, blanking what does not apply', async () => {
    const wb = await build();
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const cols = orderedColumns(SCHEMA);
    const expCol = cols.indexOf('workExperience') + 1;
    const roleCol = cols.indexOf('lastRole') + 1;

    // `workExperience` has two values, so both branches are demonstrated — one
    // row cannot show that `lastRole` only applies to "Worked before".
    const rows = [2, 3].map((r) => ({
      experience: String(sample.getCell(r, expCol).value ?? ''),
      lastRole: String(sample.getCell(r, roleCol).value ?? ''),
    }));
    expect(rows.map((r) => r.experience)).toEqual(['Fresher', 'Worked before']);
    expect(rows[0]?.lastRole).toBe('');
    expect(rows[1]?.lastRole).not.toBe('');
  });

  it('rotates the other closed sets so each value is demonstrated somewhere', async () => {
    const wb = await build();
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const genderCol = orderedColumns(SCHEMA).indexOf('gender') + 1;
    const seen = new Set<string>();
    for (let r = 2; r <= sample.rowCount; r += 1) {
      seen.add(String(sample.getCell(r, genderCol).value ?? ''));
    }
    // Two sample rows, so at least two of the three genders appear rather than
    // the first option repeating.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('samples the configured identity columns realistically, not as prose', async () => {
    // ka-dhwd's phone declares no `pattern`, so the purely schema-driven
    // generator yields "Example Mobile Number" — a cell the row parser rejects,
    // in the one field the network dedups on. The column is named by config.
    const loose = {
      type: 'object',
      required: ['fullName', 'mobile'],
      properties: {
        fullName: { type: 'string', title: 'Full name' },
        mobile: { type: 'string', title: 'Mobile Number' },
        mailId: { type: 'string', title: 'Email' },
      },
    } as Record<string, unknown>;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildXlsxTemplate(loose, 'seeker', {
        identity: { name: 'fullName', phone: 'mobile', email: 'mailId' },
      })) as unknown as ExcelJS.Buffer,
    );
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const cols = orderedColumns(loose);

    expect(String(sample.getCell(2, cols.indexOf('mobile') + 1).value)).toMatch(/^\d{10}$/);
    expect(String(sample.getCell(2, cols.indexOf('mailId') + 1).value)).toContain('@example.com');
  });

  it('honours a non-pipe delimiter from the network config', async () => {
    const wb = await build(';');
    const sheet = wb.getWorksheet(TAB_VALUES)!;
    let multi = '';
    sheet.eachRow((row) => {
      if (String(row.getCell(1).value) === 'languageSpoken') multi = String(row.getCell(4).value);
    });
    expect(multi).toContain(';');
  });

  // ── Protection + robustness ──────────────────────────────────────────────

  it('locks the read-only tabs and leaves the grid editable', async () => {
    const wb = await build();
    for (const name of [TAB_INSTRUCTIONS, TAB_VALUES, TAB_SAMPLE]) {
      expect(wb.getWorksheet(name)!.protect).toBeDefined();
      // exceljs surfaces protection on load as `sheetProtection`.
      expect(
        (wb.getWorksheet(name) as unknown as { sheetProtection?: unknown }).sheetProtection,
      ).toBeDefined();
    }
    // The grid stays unprotected: locking it would mean unlocking 18,000 data
    // cells to keep paste working, and a paste that silently fails is worse
    // than an edited header.
    expect(
      (wb.getWorksheet(TAB_GRID) as unknown as { sheetProtection?: unknown }).sheetProtection,
    ).toBeUndefined();
  });

  it('handles a schema with no properties without throwing', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildXlsxTemplate(
        { type: 'object' } as Record<string, unknown>,
        'seeker',
      )) as unknown as ExcelJS.Buffer,
    );
    expect(wb.getWorksheet(TAB_GRID)).toBeDefined();
    expect(wb.getWorksheet(TAB_INSTRUCTIONS)).toBeDefined();
  });
});

describe('columnLetter', () => {
  it('maps 1-based indexes onto spreadsheet letters past Z', () => {
    // ka-dhwd's provider schema is 40 columns wide, so AA+ is reached in
    // practice and an off-by-one here would point a dropdown at the wrong list.
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(40)).toBe('AN');
    expect(columnLetter(52)).toBe('AZ');
    expect(columnLetter(53)).toBe('BA');
  });
});
