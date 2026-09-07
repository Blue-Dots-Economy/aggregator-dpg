import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildXlsxTemplate, columnLetter } from '../index.js';
import { buildCsvTemplate, orderedColumns } from '../../csv-template/index.js';

/**
 * Mirrors the shapes the real networks use, including the two that constrain
 * the design: a closed set far past Excel's 255-character inline-list cap
 * (ka-dhwd's `itiTrade` is 170 values / 5,555 chars), and an array column whose
 * cell holds several delimiter-joined values.
 */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'phone'],
  properties: {
    name: { type: 'string', title: 'Full name', minLength: 1 },
    phone: { type: 'string', title: 'Mobile', pattern: '^[0-9]{10}$' },
    age: { type: 'integer', title: 'Age', minimum: 14, maximum: 65 },
    gender: { type: 'string', enum: ['Male', 'Female', 'Other'] },
    workExperience: {
      type: 'string',
      enum: ['Fresher', 'Worked before'],
    },
    lastRole: { type: 'string', 'x-show-if': { workExperience: ['Worked before'] } },
    languageSpoken: { type: 'array', items: { enum: ['Hindi', 'English', 'Kannada'] } },
    // 300 values: nowhere near an inline list, so it must resolve via a range.
    itiTrade: { type: 'string', enum: Array.from({ length: 300 }, (_, i) => `Trade ${i + 1}`) },
    notes: { type: 'string', description: 'Anything else worth knowing' },
  },
} as Record<string, unknown>;

async function open(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

describe('buildXlsxTemplate', () => {
  it('produces a workbook Excel can reopen', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA));
    expect(wb.getWorksheet('Template')).toBeDefined();
    expect(wb.getWorksheet('Column guide')).toBeDefined();
  });

  it('uses the SAME columns in the same order as the CSV template', async () => {
    // The whole point: an operator exports this workbook to CSV and uploads it,
    // so a divergence here produces a file the parser rejects.
    const wb = await open(await buildXlsxTemplate(SCHEMA));
    const sheet = wb.getWorksheet('Template')!;
    const expected = orderedColumns(SCHEMA);
    const header = expected.map((_, i) => String(sheet.getRow(1).getCell(i + 1).value ?? ''));

    expect(header).toEqual(expected);
    // And identical to the CSV template's own header line.
    expect(header.join(',')).toBe(buildCsvTemplate(SCHEMA, { exampleRow: false }).trimEnd());
  });

  it('puts required columns first, matching the schema order', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA));
    const sheet = wb.getWorksheet('Template')!;
    expect(String(sheet.getRow(1).getCell(1).value)).toBe('name');
    expect(String(sheet.getRow(1).getCell(2).value)).toBe('phone');
  });

  it('attaches a list validation to every single-value closed set', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA));
    const sheet = wb.getWorksheet('Template')!;
    const cols = orderedColumns(SCHEMA);

    const genderCol = cols.indexOf('gender') + 1;
    const validation = sheet.getCell(2, genderCol).dataValidation;
    expect(validation?.type).toBe('list');
    // A range, never an inline list — Excel caps inline lists at 255 chars and
    // `itiTrade` below is far past it, so the mechanism has to be uniform.
    expect(validation?.formulae?.[0]).toContain("'Lists'!$");
  });

  it('backs a 300-value set with a range rather than an inline list', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA));
    const sheet = wb.getWorksheet('Template')!;
    const col = orderedColumns(SCHEMA).indexOf('itiTrade') + 1;
    const formula = sheet.getCell(2, col).dataValidation?.formulae?.[0] as string;

    expect(formula).toMatch(/'Lists'!\$[A-Z]+\$2:\$[A-Z]+\$301/);
    expect(formula.length).toBeLessThan(255);
  });

  it('leaves array columns without a dropdown, since one cell holds many values', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA));
    const sheet = wb.getWorksheet('Template')!;
    const col = orderedColumns(SCHEMA).indexOf('languageSpoken') + 1;
    // A single-value dropdown would reject the valid `Hindi|English`.
    expect(sheet.getCell(2, col).dataValidation).toBeUndefined();
  });

  it('hides the lists sheet so its values cannot be edited into the schema', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA));
    expect(wb.getWorksheet('Lists')!.state).toBe('veryHidden');
  });

  it('seeds the example row from the CSV generator, so it is parser-valid', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA, { arrayDelimiter: '|' }));
    const sheet = wb.getWorksheet('Template')!;
    const cols = orderedColumns(SCHEMA);

    // Numeric bounds and patterns survive because the real schema fragment is
    // used, not a reconstruction: age is mid-range, phone matches the pattern.
    expect(String(sheet.getCell(2, cols.indexOf('age') + 1).value)).toBe('40');
    expect(String(sheet.getCell(2, cols.indexOf('phone') + 1).value)).toBe('9876543210');
    // Array cell demonstrates the delimiter the parser splits on.
    expect(String(sheet.getCell(2, cols.indexOf('languageSpoken') + 1).value)).toContain('|');
  });

  it('documents every column in the guide, with required and delimiter facts', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA, { arrayDelimiter: '|' }));
    const guide = wb.getWorksheet('Column guide')!;
    const rows: Record<string, string[]> = {};
    guide.eachRow((row, n) => {
      if (n === 1) return;
      const cells = [1, 2, 3, 4, 5].map((c) => String(row.getCell(c).value ?? ''));
      rows[cells[0] as string] = cells;
    });

    expect(Object.keys(rows)).toHaveLength(orderedColumns(SCHEMA).length);
    expect(rows['name']?.[1]).toBe('Yes');
    expect(rows['age']?.[1]).toBe('No');
    expect(rows['languageSpoken']?.[2]).toContain('|');
    expect(rows['lastRole']?.[3]).toContain('workExperience');
    expect(rows['gender']?.[4]).toBe('Male, Female, Other');
    // Free-text columns fall back to their description rather than being blank.
    expect(rows['notes']?.[4]).toBe('Anything else worth knowing');
  });

  it('honours a non-pipe delimiter from the network config', async () => {
    const wb = await open(await buildXlsxTemplate(SCHEMA, { arrayDelimiter: ';' }));
    const guide = wb.getWorksheet('Column guide')!;
    let found = '';
    guide.eachRow((row) => {
      if (String(row.getCell(1).value) === 'languageSpoken') found = String(row.getCell(3).value);
    });
    expect(found).toContain(';');
  });

  it('handles a schema with no properties without throwing', async () => {
    const wb = await open(await buildXlsxTemplate({ type: 'object' } as Record<string, unknown>));
    expect(wb.getWorksheet('Template')).toBeDefined();
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
