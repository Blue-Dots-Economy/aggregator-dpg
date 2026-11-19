/**
 * Pure CSV parsing for the org structure loader (`orgs.csv`, `coordinators.csv`).
 *
 * Turns text into typed rows plus {@link InputProblem}s. No DB, no network
 * config and no phone normalisation; later steps build the load plan from
 * these rows. Every non-empty data row is returned; a missing required
 * string field is '' (and `profileTypes` []), and `problems` says what blocks
 * the row. Consumers must treat a row with any problem as not plannable.
 */

import Papa from 'papaparse';
import type { PlanProblemCode } from './org-loader-plan-shared.js';

/** Keys of the org form's address block. */
export type AddressPart =
  | 'streetAddress'
  | 'addressLocality'
  | 'addressDistrict'
  | 'addressRegion'
  | 'postalCode'
  | 'addressCountry';

/** The address parts, in form order; each is the CSV column `address_<part>`. */
export const ADDRESS_PARTS: readonly AddressPart[] = [
  'streetAddress',
  'addressLocality',
  'addressDistrict',
  'addressRegion',
  'postalCode',
  'addressCountry',
];

/** Prefix of the address columns. */
export const ADDRESS_PREFIX = 'address_';

/** One org to create, from `orgs.csv`. */
export interface OrgRow {
  /** 1-based file line; the first data row is line 2. */
  line: number;
  name: string;
  parent: string | null;
  owner: { name: string; email: string; phone: string };
  extra: Record<string, string>;
  address: Partial<Record<AddressPart, string>>;
}

/** One coordinator to create, from `coordinators.csv`. */
export interface CoordinatorRow {
  line: number;
  org: string;
  name: string;
  email: string;
  phone: string;
  profileTypes: string[];
  extra: Record<string, string>;
}

/** A problem in an input file. `line` is 1 for header problems. */
export interface InputProblem {
  file: 'orgs' | 'coordinators';
  line: number;
  code: InputProblemCode | PlanProblemCode;
  field?: string;
}

/** Problem codes this module emits; later stages should reuse these. */
export const INPUT_PROBLEM = {
  MISSING_COLUMN: 'MISSING_COLUMN',
  REQUIRED: 'REQUIRED',
  MALFORMED_ROW: 'MALFORMED_ROW',
} as const;

/** One of the {@link INPUT_PROBLEM} codes. */
export type InputProblemCode = (typeof INPUT_PROBLEM)[keyof typeof INPUT_PROBLEM];

const EXTRA_KEY = '__parsed_extra';

interface ParsedFile {
  columns: Set<string>;
  /** Each non-empty record's cells keyed by normalised header, trimmed, empty cells absent. */
  records: Array<{ line: number; cells: Record<string, string> }>;
  /** Parser-level problems (ragged rows, quote errors), keyed to the record's line. */
  malformed: Array<{ line: number }>;
}

const ORG_REQUIRED = ['name', 'owner_name', 'owner_phone', 'owner_email'] as const;

/** Fixed columns of `orgs.csv`, before the schema's own fields; all but `parent` are required. */
export const ORG_FIXED_COLUMNS: readonly string[] = [
  'name',
  'parent',
  'owner_name',
  'owner_phone',
  'owner_email',
];
const COORD_REQUIRED = ['org', 'name', 'phone', 'email', 'profile_types'] as const;

/**
 * Normalise a header: trim and lowercase, except the case-sensitive suffix of
 * an `address_*` column, which keeps its case (`address_postalCode`).
 */
function normaliseHeader(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(ADDRESS_PREFIX)) {
    const suffix = trimmed.slice(ADDRESS_PREFIX.length);
    const part = ADDRESS_PARTS.find((p) => p.toLowerCase() === suffix.toLowerCase());
    return ADDRESS_PREFIX + (part ?? suffix);
  }
  return lower;
}

/**
 * Parse CSV text. Blank rows are dropped here (not by Papa) so each record
 * keeps its physical line. Line numbers assume one record per physical line;
 * a quoted cell containing a newline shifts later lines (known limitation).
 */
function parseFile(text: string): ParsedFile {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<Record<string, string>>(body, {
    header: true,
    delimiter: ',',
    skipEmptyLines: false,
    transformHeader: normaliseHeader,
  });
  const columns = new Set((result.meta.fields ?? []).filter((f) => f !== ''));
  const records: ParsedFile['records'] = [];
  const emptyIdx = new Set<number>();
  result.data.forEach((raw, i) => {
    const cells: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      const cell = typeof value === 'string' ? value.trim() : '';
      if (key !== '' && key !== EXTRA_KEY && cell !== '') cells[key] = cell;
    }
    const hasExtra = Array.isArray(raw[EXTRA_KEY]);
    if (Object.keys(cells).length === 0 && !hasExtra) {
      emptyIdx.add(i);
      return;
    }
    records.push({ line: i + 2, cells });
  });
  const lines = new Set<number>();
  for (const err of result.errors) {
    if (err.row === undefined || emptyIdx.has(err.row)) continue;
    lines.add(err.row + 2);
  }
  result.data.forEach((raw, i) => {
    if (Array.isArray(raw[EXTRA_KEY]) && !emptyIdx.has(i)) lines.add(i + 2);
  });
  return { columns, records, malformed: [...lines].map((line) => ({ line })) };
}

function malformedProblems(file: InputProblem['file'], parsed: ParsedFile): InputProblem[] {
  return parsed.malformed.map(({ line }) => ({
    file,
    line,
    code: INPUT_PROBLEM.MALFORMED_ROW,
  }));
}

/** A required cell's value, or '' when absent (the problems list says why). */
function cell(cells: Record<string, string>, key: string): string {
  return cells[key] ?? '';
}

function missingColumns(
  file: InputProblem['file'],
  columns: Set<string>,
  required: readonly string[],
): InputProblem[] {
  return required
    .filter((c) => !columns.has(c))
    .map((field) => ({ file, line: 1, code: INPUT_PROBLEM.MISSING_COLUMN, field }));
}

/**
 * Parse `orgs.csv`.
 *
 * @returns The rows, the parser's problems and the normalised header columns, in file order.
 */
export function parseOrgsCsv(text: string): {
  rows: OrgRow[];
  problems: InputProblem[];
  columns: string[];
} {
  const parsed = parseFile(text);
  const { columns, records } = parsed;
  const problems = [
    ...missingColumns('orgs', columns, ORG_REQUIRED),
    ...malformedProblems('orgs', parsed),
  ];
  const rows: OrgRow[] = [];
  const known = new Set<string>([
    ...ORG_FIXED_COLUMNS,
    ...ADDRESS_PARTS.map((p) => ADDRESS_PREFIX + p),
  ]);
  for (const { line, cells } of records) {
    for (const field of ORG_REQUIRED) {
      if (columns.has(field) && cells[field] === undefined) {
        problems.push({ file: 'orgs', line, code: INPUT_PROBLEM.REQUIRED, field });
      }
    }
    const address: Partial<Record<AddressPart, string>> = {};
    for (const part of ADDRESS_PARTS) {
      const v = cells[ADDRESS_PREFIX + part];
      if (v !== undefined) address[part] = v;
    }
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(cells)) if (!known.has(k)) extra[k] = v;
    rows.push({
      line,
      name: cell(cells, 'name'),
      parent: cells['parent'] ?? null,
      owner: {
        name: cell(cells, 'owner_name'),
        email: cell(cells, 'owner_email').toLowerCase(),
        phone: cell(cells, 'owner_phone'),
      },
      extra,
      address,
    });
  }
  return { rows, problems, columns: [...columns] };
}

/** Parse `coordinators.csv`. `profile_types` is a `;`-separated list. */
export function parseCoordinatorsCsv(text: string): {
  rows: CoordinatorRow[];
  problems: InputProblem[];
} {
  const parsed = parseFile(text);
  const { columns, records } = parsed;
  const problems = [
    ...missingColumns('coordinators', columns, COORD_REQUIRED),
    ...malformedProblems('coordinators', parsed),
  ];
  const rows: CoordinatorRow[] = [];
  const known = new Set<string>(COORD_REQUIRED);
  for (const { line, cells } of records) {
    for (const field of COORD_REQUIRED) {
      if (columns.has(field) && cells[field] === undefined) {
        problems.push({ file: 'coordinators', line, code: INPUT_PROBLEM.REQUIRED, field });
      }
    }
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(cells)) if (!known.has(k)) extra[k] = v;
    rows.push({
      line,
      org: cell(cells, 'org'),
      name: cell(cells, 'name'),
      email: cell(cells, 'email').toLowerCase(),
      phone: cell(cells, 'phone'),
      profileTypes: cell(cells, 'profile_types')
        .split(';')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      extra,
    });
  }
  return { rows, problems };
}
