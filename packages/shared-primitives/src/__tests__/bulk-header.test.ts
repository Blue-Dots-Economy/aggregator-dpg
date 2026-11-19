/**
 * The bulk CSV header rule shared by the worker's file processor and the API's
 * bulk-upload command.
 */
import { describe, it, expect } from 'vitest';
import {
  bulkHeaderColumns,
  checkBulkHeader,
  CSV_FIELD_DELIMITER,
  GEO_LOCATION_COLUMN,
  normaliseHeaderCells,
} from '../bulk-columns/index.js';

/** Sorts column names as text. */
const byText = (a: string, b: string): number => a.localeCompare(b);

const SCHEMA = {
  type: 'object',
  required: ['name', 'phone', 7],
  properties: { name: {}, phone: {}, age: {} },
};

describe('CSV_FIELD_DELIMITER', () => {
  it('is a comma', () => {
    expect(CSV_FIELD_DELIMITER).toBe(',');
  });
});

describe('bulkHeaderColumns', () => {
  it('requires the schema required strings and allows its properties plus well-known columns', () => {
    const cols = bulkHeaderColumns(SCHEMA);
    expect(cols.required).toEqual(['name', 'phone']);
    expect([...cols.allowed].sort(byText)).toEqual(
      ['age', GEO_LOCATION_COLUMN, 'name', 'phone'].sort(byText),
    );
  });

  it('requires nothing and allows only well-known columns for a schema without either', () => {
    const cols = bulkHeaderColumns({});
    expect(cols.required).toEqual([]);
    expect([...cols.allowed]).toEqual([GEO_LOCATION_COLUMN]);
  });
});

describe('normaliseHeaderCells', () => {
  it('trims each cell and turns a missing cell into an empty string', () => {
    expect(normaliseHeaderCells([' name ', 'phone\t', undefined, null])).toEqual([
      'name',
      'phone',
      '',
      '',
    ]);
  });
});

describe('checkBulkHeader', () => {
  const cols = bulkHeaderColumns(SCHEMA);

  it('accepts a header with every required column and only allowed ones', () => {
    expect(checkBulkHeader(['name', 'phone', GEO_LOCATION_COLUMN], cols)).toBeNull();
  });

  it('reports missing required columns first', () => {
    expect(checkBulkHeader(['name', 'shoe'], cols)).toEqual({
      kind: 'missing',
      columns: ['phone'],
    });
  });

  it('reports unknown columns', () => {
    expect(checkBulkHeader(['name', 'phone', 'shoe', 'hat'], cols)).toEqual({
      kind: 'unknown',
      columns: ['shoe', 'hat'],
    });
  });

  it('treats an empty header as missing every required column', () => {
    expect(checkBulkHeader([], cols)).toEqual({ kind: 'missing', columns: ['name', 'phone'] });
  });
});
