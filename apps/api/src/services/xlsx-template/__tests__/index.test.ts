import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildXlsxTemplate,
  columnLetter,
  dataSheetName,
  enumeratedSheetName,
  sampleSheetName,
} from '../index.js';
import { buildCsvTemplate, orderedColumns } from '../../csv-template/index.js';

/**
 * Mirrors the shapes the real networks use, including the three that constrain
 * the design: a closed set far past Excel's 255-character inline-list cap
 * (ka-dhwd's `itiTrade` is 170 values / 5,555 chars), an array column whose
 * cell holds several delimiter-joined values, and an `x-show-if` pair.
 */
const SEEKER = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'phone'],
  properties: {
    name: { type: 'string', title: 'Full name', minLength: 1 },
    phone: { type: 'string', title: 'Mobile', pattern: '^[0-9]{10}$' },
    age: { type: 'integer', title: 'Age', minimum: 14, maximum: 65 },
    gender: { type: 'string', enum: ['Male', 'Female', 'Other'] },
    workExperience: { type: 'string', enum: ['Fresher', 'Worked before'] },
    lastRole: { type: 'string', 'x-show-if': { workExperience: ['Worked before'] } },
    languageSpoken: { type: 'array', items: { enum: ['Hindi', 'English', 'Kannada'] } },
    // 300 values: nowhere near an inline list, so it must resolve via a range.
    itiTrade: { type: 'string', enum: Array.from({ length: 300 }, (_, i) => `Trade ${i + 1}`) },
    notes: { type: 'string', description: 'Anything else worth knowing' },
  },
} as Record<string, unknown>;

const PROVIDER = {
  type: 'object',
  additionalProperties: false,
  required: ['orgName'],
  properties: {
    orgName: { type: 'string', title: 'Organisation' },
    // Same field name as no seeker column, but a DIFFERENT closed set from the
    // seeker's `gender` — proves the range map is keyed per domain.
    sector: { type: 'string', enum: ['Manufacturing', 'Retail'] },
  },
} as Record<string, unknown>;

const DOMAINS = [
  { id: 'seeker', schema: SEEKER },
  { id: 'provider', schema: PROVIDER },
];

async function open(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

/** Builds the two-domain workbook the majority of these cases assert against. */
async function build(delimiter = '|'): Promise<ExcelJS.Workbook> {
  return open(await buildXlsxTemplate(DOMAINS, { network: 'blue_dot', arrayDelimiter: delimiter }));
}

/** Header row of a sheet, as strings. */
function header(sheet: ExcelJS.Worksheet, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    String(sheet.getRow(1).getCell(i + 1).value ?? ''),
  );
}

describe('buildXlsxTemplate', () => {
  it('produces a workbook Excel can reopen, with a sheet group per domain', async () => {
    const wb = await build();
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'Instructions',
      'Lists',
      'sample_blue_dot_seekers',
      'blue_dot_seekers_data',
      'enumerated_seeker',
      'sample_blue_dot_providers',
      'blue_dot_providers_data',
      'enumerated_provider',
    ]);
  });

  it('uses the SAME columns in the same order as the CSV template', async () => {
    // The whole point: an operator exports the _data sheet to CSV and uploads
    // it, so a divergence here produces a file the parser rejects.
    const wb = await build();
    const expected = orderedColumns(SEEKER);
    const data = wb.getWorksheet('blue_dot_seekers_data')!;

    expect(header(data, expected.length)).toEqual(expected);
    expect(header(data, expected.length).join(',')).toBe(
      buildCsvTemplate(SEEKER, { exampleRow: false }).trimEnd(),
    );
    // The sample sheet has to match the fill-in sheet column for column, or a
    // row copied across from it lands in the wrong columns.
    expect(header(wb.getWorksheet('sample_blue_dot_seekers')!, expected.length)).toEqual(expected);
  });

  it('puts required columns first, matching the schema order', async () => {
    const wb = await build();
    const data = wb.getWorksheet('blue_dot_seekers_data')!;
    expect(String(data.getRow(1).getCell(1).value)).toBe('name');
    expect(String(data.getRow(1).getCell(2).value)).toBe('phone');
  });

  it('leaves the fill-in sheet empty so nothing sample gets uploaded by accident', async () => {
    const wb = await build();
    const data = wb.getWorksheet('blue_dot_seekers_data')!;
    const firstDataRow = orderedColumns(SEEKER).map((_, i) => data.getCell(2, i + 1).value);

    // Every cell below the header is blank. (rowCount is not the assertion:
    // the validation range materialises rows 2-500 as styled-but-valueless.)
    expect(firstDataRow.every((v) => v === null || v === undefined)).toBe(true);
    // The examples live on their own sheet, where they cannot be uploaded.
    expect(wb.getWorksheet('sample_blue_dot_seekers')!.rowCount).toBeGreaterThan(1);
  });

  it('attaches a list validation to every single-value closed set', async () => {
    const wb = await build();
    const data = wb.getWorksheet('blue_dot_seekers_data')!;
    const genderCol = orderedColumns(SEEKER).indexOf('gender') + 1;
    const validation = data.getCell(2, genderCol).dataValidation;

    expect(validation?.type).toBe('list');
    // A range, never an inline list — Excel caps inline lists at 255 chars and
    // `itiTrade` is far past it, so the mechanism has to be uniform.
    expect(validation?.formulae?.[0]).toContain("'Lists'!$");
  });

  it('backs a 300-value set with a range rather than an inline list', async () => {
    const wb = await build();
    const data = wb.getWorksheet('blue_dot_seekers_data')!;
    const col = orderedColumns(SEEKER).indexOf('itiTrade') + 1;
    const formula = data.getCell(2, col).dataValidation?.formulae?.[0] as string;

    expect(formula).toMatch(/'Lists'!\$[A-Z]+\$2:\$[A-Z]+\$301/);
    expect(formula.length).toBeLessThan(255);
  });

  it('gives each domain its OWN range, so one type cannot inherit the other options', async () => {
    const wb = await build();
    const seekerRange = wb
      .getWorksheet('blue_dot_seekers_data')!
      .getCell(2, orderedColumns(SEEKER).indexOf('gender') + 1).dataValidation?.formulae?.[0];
    const providerRange = wb
      .getWorksheet('blue_dot_providers_data')!
      .getCell(2, orderedColumns(PROVIDER).indexOf('sector') + 1).dataValidation?.formulae?.[0];

    expect(seekerRange).toBeDefined();
    expect(providerRange).toBeDefined();
    expect(providerRange).not.toBe(seekerRange);
    // Keys are domain-qualified on the hidden sheet for the same reason.
    const listHeaders: string[] = [];
    wb.getWorksheet('Lists')!
      .getRow(1)
      .eachCell((c) => listHeaders.push(String(c.value)));
    expect(listHeaders).toContain('seeker.gender');
    expect(listHeaders).toContain('provider.sector');
  });

  it('leaves array columns without a dropdown, since one cell holds many values', async () => {
    const wb = await build();
    const col = orderedColumns(SEEKER).indexOf('languageSpoken') + 1;
    // A single-value dropdown would reject the valid `Hindi|English`.
    expect(
      wb.getWorksheet('blue_dot_seekers_data')!.getCell(2, col).dataValidation,
    ).toBeUndefined();
  });

  it('hides the lists sheet so its values cannot be edited into the schema', async () => {
    const wb = await build();
    expect(wb.getWorksheet('Lists')!.state).toBe('veryHidden');
  });

  it('seeds sample rows from the CSV generator, so they are parser-valid', async () => {
    const wb = await build();
    const sample = wb.getWorksheet('sample_blue_dot_seekers')!;
    const cols = orderedColumns(SEEKER);

    // Numeric bounds and patterns survive because the real schema fragment is
    // used, not a reconstruction: age is mid-range, phone matches the pattern.
    expect(String(sample.getCell(2, cols.indexOf('age') + 1).value)).toBe('40');
    expect(String(sample.getCell(2, cols.indexOf('phone') + 1).value)).toBe('9876543210');
    // Array cell demonstrates the delimiter the parser splits on.
    expect(String(sample.getCell(2, cols.indexOf('languageSpoken') + 1).value)).toContain('|');
  });

  it('samples the CONFIGURED identity columns realistically, not as prose', async () => {
    // ka-dhwd's seeker phone declares neither `format` nor `pattern`, so the
    // purely schema-driven generator yields "Example Mobile Number" — a cell
    // the row parser rejects, in the one field the network dedups on. The
    // column is named by config, so nothing is guessed.
    const looseSchema = {
      type: 'object',
      required: ['fullName', 'mobile'],
      properties: {
        fullName: { type: 'string', title: 'Full name' },
        mobile: { type: 'string', title: 'Mobile Number' },
        mailId: { type: 'string', title: 'Email' },
      },
    } as Record<string, unknown>;
    const wb = await open(
      await buildXlsxTemplate([
        {
          id: 'seeker',
          schema: looseSchema,
          identity: { name: 'fullName', phone: 'mobile', email: 'mailId' },
        },
      ]),
    );
    const sample = wb.getWorksheet('sample_network_seekers')!;
    const cols = orderedColumns(looseSchema);

    expect(String(sample.getCell(2, cols.indexOf('mobile') + 1).value)).toBe('9876543210');
    expect(String(sample.getCell(2, cols.indexOf('mailId') + 1).value)).toBe('person@example.com');
  });

  it('emits one sample row per controller value, blanking conditionals that do not apply', async () => {
    const wb = await build();
    const sample = wb.getWorksheet('sample_blue_dot_seekers')!;
    const cols = orderedColumns(SEEKER);
    const expCol = cols.indexOf('workExperience') + 1;
    const roleCol = cols.indexOf('lastRole') + 1;

    // `workExperience` has two values, so both branches are demonstrated —
    // one row cannot show that `lastRole` only applies to "Worked before".
    const rows = [2, 3].map((r) => ({
      experience: String(sample.getCell(r, expCol).value ?? ''),
      lastRole: String(sample.getCell(r, roleCol).value ?? ''),
    }));
    expect(rows.map((r) => r.experience)).toEqual(['Fresher', 'Worked before']);
    expect(rows[0]?.lastRole).toBe('');
    expect(rows[1]?.lastRole).not.toBe('');
  });

  it('lists every closed set on the enumerated sheet, delimiter-joined', async () => {
    const wb = await build();
    const sheet = wb.getWorksheet('enumerated_seeker')!;
    expect(['domain', 'field', 'options', 'several values', 'only fill in when']).toEqual(
      [1, 2, 3, 4, 5].map((r) => String(sheet.getCell(r, 1).value)),
    );

    const byField = new Map<string, string[]>();
    for (let col = 2; col <= sheet.columnCount; col += 1) {
      byField.set(
        String(sheet.getCell(2, col).value),
        [3, 4, 5].map((r) => String(sheet.getCell(r, col).value ?? '')),
      );
    }
    expect(byField.get('gender')?.[0]).toBe('Male|Female|Other');
    expect(byField.get('languageSpoken')?.[1]).toContain('yes');
    expect(byField.get('itiTrade')?.[0]?.split('|')).toHaveLength(300);
    // Free-text columns are not closed sets and have no business here.
    expect(byField.has('notes')).toBe(false);
  });

  it('honours a non-pipe delimiter from the network config', async () => {
    const wb = await build(';');
    const sheet = wb.getWorksheet('enumerated_seeker')!;
    let joined = '';
    for (let col = 2; col <= sheet.columnCount; col += 1) {
      if (String(sheet.getCell(2, col).value) === 'gender') {
        joined = String(sheet.getCell(3, col).value);
      }
    }
    expect(joined).toBe('Male;Female;Other');
  });

  it('names every tab it actually created on the instructions sheet', async () => {
    const wb = await build();
    const lines: string[] = [];
    wb.getWorksheet('Instructions')!.eachRow((row) =>
      lines.push(String(row.getCell(1).value ?? '')),
    );
    const text = lines.join('\n');

    for (const name of wb.worksheets.map((s) => s.name)) {
      if (name === 'Instructions' || name === 'Lists') continue;
      expect(text).toContain(name);
    }
    // The reference's Admin Details block is deliberately not reproduced.
    expect(text.toLowerCase()).not.toContain('admin details');
  });

  it('handles a schema with no properties without throwing', async () => {
    const wb = await open(
      await buildXlsxTemplate([
        { id: 'seeker', schema: { type: 'object' } as Record<string, unknown> },
      ]),
    );
    expect(wb.getWorksheet('sample_network_seekers')).toBeDefined();
  });

  it('handles no domains at all, rather than emitting a corrupt workbook', async () => {
    const wb = await open(await buildXlsxTemplate([]));
    expect(wb.getWorksheet('Instructions')).toBeDefined();
  });
});

describe('sheet naming', () => {
  it('keeps the reference workbook names for short domain ids', () => {
    expect(sampleSheetName('blue_dot', 'provider')).toBe('sample_blue_dot_providers');
    expect(dataSheetName('blue_dot', 'seeker')).toBe('blue_dot_seekers_data');
    expect(enumeratedSheetName('seeker')).toBe('enumerated_seeker');
  });

  it('drops the network prefix rather than exceeding Excel 31-character cap', () => {
    // `sample_blue_dot_service_providers` is 33 chars — Excel refuses it, and a
    // blind truncation would collide with the sibling sheet.
    const sample = sampleSheetName('blue_dot', 'service_provider');
    expect(sample).toBe('sample_service_providers');
    expect(sample.length).toBeLessThanOrEqual(31);

    // The data sheet's own name lands on exactly 31, so it keeps the prefix.
    const data = dataSheetName('blue_dot', 'service_provider');
    expect(data).toBe('blue_dot_service_providers_data');
    expect(data.length).toBe(31);
  });

  it('never returns a name past the cap, even for an absurd domain id', () => {
    const id = 'a'.repeat(60);
    for (const name of [
      sampleSheetName('blue_dot', id),
      dataSheetName('blue_dot', id),
      enumeratedSheetName(id),
    ]) {
      expect(name.length).toBeLessThanOrEqual(31);
    }
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
