/**
 * Pure CSV parsing for the org structure loader (`orgs.csv`, `coordinators.csv`).
 *
 * Turns text into typed rows plus {@link InputProblem}s. No DB, no network
 * config and no phone normalisation; later steps build the load plan from
 * these rows. A row with a missing required cell is reported and left out of
 * `rows`, so every returned row has all its required fields.
 */

import Papa from 'papaparse';

/** Keys of the org form's address block. */
export type AddressPart =
  | 'streetAddress'
  | 'addressLocality'
  | 'addressDistrict'
  | 'addressRegion'
  | 'postalCode'
  | 'addressCountry';

const ADDRESS_PARTS: readonly AddressPart[] = [
  'streetAddress',
  'addressLocality',
  'addressDistrict',
  'addressRegion',
  'postalCode',
  'addressCountry',
];

const ADDRESS_PREFIX = 'address_';

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
  code: string;
  field?: string;
}

interface ParsedFile {
  columns: Set<string>;
  /** Each record's cells keyed by normalised header, trimmed, empty cells absent. */
  records: Array<{ line: number; cells: Record<string, string> }>;
}

const ORG_REQUIRED = ['name', 'owner_name', 'owner_phone', 'owner_email'] as const;
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

function parseFile(text: string): ParsedFile {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<Record<string, string>>(body, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: normaliseHeader,
  });
  const columns = new Set((result.meta.fields ?? []).filter((f) => f !== ''));
  const records = result.data.map((raw, i) => {
    const cells: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      const cell = typeof value === 'string' ? value.trim() : '';
      if (key !== '' && cell !== '') cells[key] = cell;
    }
    return { line: i + 2, cells };
  });
  return { columns, records };
}

/** A required cell's value; the caller has already checked it is present. */
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
    .map((field) => ({ file, line: 1, code: 'MISSING_COLUMN', field }));
}

/** Parse `orgs.csv`. */
export function parseOrgsCsv(text: string): { rows: OrgRow[]; problems: InputProblem[] } {
  const { columns, records } = parseFile(text);
  const problems = missingColumns('orgs', columns, ORG_REQUIRED);
  const rows: OrgRow[] = [];
  const known = new Set<string>([
    ...ORG_REQUIRED,
    'parent',
    ...ADDRESS_PARTS.map((p) => ADDRESS_PREFIX + p),
  ]);
  for (const { line, cells } of records) {
    const missing = ORG_REQUIRED.filter((f) => columns.has(f) && cells[f] === undefined);
    for (const field of missing) problems.push({ file: 'orgs', line, code: 'REQUIRED', field });
    if (missing.length > 0 || problems.some((p) => p.code === 'MISSING_COLUMN')) continue;
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
  return { rows, problems };
}

/** Parse `coordinators.csv`. `profile_types` is a `;`-separated list. */
export function parseCoordinatorsCsv(text: string): {
  rows: CoordinatorRow[];
  problems: InputProblem[];
} {
  const { columns, records } = parseFile(text);
  const problems = missingColumns('coordinators', columns, COORD_REQUIRED);
  const rows: CoordinatorRow[] = [];
  const known = new Set<string>(COORD_REQUIRED);
  for (const { line, cells } of records) {
    const missing = COORD_REQUIRED.filter((f) => columns.has(f) && cells[f] === undefined);
    for (const field of missing) {
      problems.push({ file: 'coordinators', line, code: 'REQUIRED', field });
    }
    if (missing.length > 0 || problems.some((p) => p.code === 'MISSING_COLUMN')) continue;
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
