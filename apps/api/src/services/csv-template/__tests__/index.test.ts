import { describe, it, expect } from 'vitest';
import { buildCsvTemplate } from '../index.js';

/** Trimmed-down purple_dot-style seeker schema exercising every value kind. */
const SEEKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['beneficiary_name', 'mobile_number', 'age', 'gender', 'disability_type'],
  properties: {
    beneficiary_name: { type: 'string', title: 'Name', minLength: 1 },
    mobile_number: { type: 'string', title: 'Mobile', pattern: '^[0-9]{10}$' },
    age: { type: 'integer', title: 'Age', minimum: 0, maximum: 120 },
    gender: { type: 'string', enum: ['Male', 'Female', 'Other'] },
    disability_type: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: ['Low Vision', 'Blindness', 'Deaf'] },
    },
    email: { type: 'string', format: 'email' },
    pincode: { type: 'string', pattern: '^[0-9]{6}$' },
    catalog_url: { type: 'string', format: 'uri' },
    tags: { type: 'array', items: { type: 'string' } },
    consented: { type: 'boolean' },
  },
} as Record<string, unknown>;

function parse(csv: string): { header: string[]; example: string[] } {
  const lines = csv.trimEnd().split('\n');
  // naive split is fine — assertions below avoid commas inside cells except
  // where explicitly tested via the quoted-cell case.
  return { header: lines[0]!.split(','), example: (lines[1] ?? '').split(',') };
}

describe('buildCsvTemplate', () => {
  it('emits a header row followed by one example row of equal width', () => {
    const csv = buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|' });
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const { header, example } = parse(csv);
    expect(example).toHaveLength(header.length);
  });

  it('orders required properties before optional ones', () => {
    const { header } = parse(buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|' }));
    expect(header.slice(0, 5)).toEqual([
      'beneficiary_name',
      'mobile_number',
      'age',
      'gender',
      'disability_type',
    ]);
  });

  it('demonstrates array fields with the configured delimiter', () => {
    const { header, example } = parse(buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|' }));
    const cell = example[header.indexOf('disability_type')]!;
    expect(cell).toBe('Low Vision|Blindness');
    expect(example[header.indexOf('tags')]).toContain('|');
  });

  it('honours a non-default array delimiter', () => {
    const { header, example } = parse(buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: ';' }));
    expect(example[header.indexOf('disability_type')]).toBe('Low Vision;Blindness');
  });

  it('derives values that satisfy the schema constraints', () => {
    const { header, example } = parse(buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|' }));
    const get = (f: string) => example[header.indexOf(f)]!;
    expect(get('mobile_number')).toMatch(/^[0-9]{10}$/);
    expect(get('pincode')).toMatch(/^[0-9]{6}$/);
    const age = Number(get('age'));
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThanOrEqual(120);
    expect(get('gender')).toBe('Male');
    expect(get('email')).toContain('@');
    expect(get('catalog_url')).toMatch(/^https?:\/\//);
    expect(get('consented')).toBe('true');
    expect(get('beneficiary_name').length).toBeGreaterThan(0);
  });

  it('keeps backward-compatible header-only output when example row disabled', () => {
    const csv = buildCsvTemplate(SEEKER_SCHEMA, { arrayDelimiter: '|', exampleRow: false });
    expect(csv.trimEnd().split('\n')).toHaveLength(1);
  });

  it('quotes example cells containing the CSV separator', () => {
    const schema = {
      type: 'object',
      required: ['address'],
      properties: { address: { type: 'string', title: 'Address, full' } },
    } as Record<string, unknown>;
    const csv = buildCsvTemplate(schema, { arrayDelimiter: '|' });
    const example = csv.trimEnd().split('\n')[1]!;
    // a generated value containing a comma must arrive quoted
    if (example.includes(',')) {
      expect(example.startsWith('"')).toBe(true);
    }
  });

  it('defaults to the pipe delimiter when no options are given', () => {
    const { header, example } = parse(buildCsvTemplate(SEEKER_SCHEMA));
    expect(example[header.indexOf('disability_type')]).toBe('Low Vision|Blindness');
  });
});
