/**
 * CSV parsing for the QR links loader's links sheet, in `@aggregator-dpg/api`.
 *
 * Turns text into typed rows plus {@link InputProblem}s with the org loader's
 * CSV rules (BOM strip, `,` delimiter, trimmed cells, physical line numbers,
 * malformed rows reported). No DB and no network config; `qr-links-plan.ts`
 * checks the rows. A row with any problem is not plannable.
 */

import { INPUT_PROBLEM, parseFile } from './org-loader-input.js';
import type { QrPlanProblemCode } from './qr-links-plan.js';

/** One link to create, from the links sheet. Empty strings mean the cell was absent. */
export interface LinkRow {
  /** 1-based file line; the first data row is line 2. */
  line: number;
  /** Trimmed and lowercased. */
  coordinatorEmail: string;
  profileType: string;
  voiceBot: string;
  linkName: string;
  expiresOn: string;
}

/** Problem codes the links parser emits. */
export const LINK_INPUT_PROBLEM = {
  ...INPUT_PROBLEM,
  /** A header outside the five known columns; a typo would drop its values. */
  UNKNOWN_COLUMN: 'UNKNOWN_COLUMN',
} as const;

/** One of the {@link LINK_INPUT_PROBLEM} codes. */
export type LinkInputProblemCode = (typeof LINK_INPUT_PROBLEM)[keyof typeof LINK_INPUT_PROBLEM];

/** A problem in the links sheet. `line` is 1 for header and file-wide problems. */
export interface InputProblem {
  line: number;
  code: LinkInputProblemCode | QrPlanProblemCode;
  /** The CSV column the problem is about. */
  field?: string;
}

/** Columns every links sheet must have. */
const REQUIRED_COLUMNS = ['coordinator_email', 'profile_type'] as const;

/** Every column the links sheet accepts. */
export const LINK_COLUMNS: readonly string[] = [
  ...REQUIRED_COLUMNS,
  'voice_bot',
  'link_name',
  'expires_on',
];

/**
 * Parses the links sheet.
 *
 * @returns The rows, in file order, and the parser's problems.
 */
export function parseLinksCsv(text: string): { rows: LinkRow[]; problems: InputProblem[] } {
  const parsed = parseFile(text);
  const { columns, records } = parsed;
  const known = new Set(LINK_COLUMNS);
  const problems: InputProblem[] = [
    ...REQUIRED_COLUMNS.filter((c) => !columns.has(c)).map((field) => ({
      line: 1,
      code: LINK_INPUT_PROBLEM.MISSING_COLUMN,
      field,
    })),
    ...[...columns]
      .filter((c) => !known.has(c))
      .map((field) => ({ line: 1, code: LINK_INPUT_PROBLEM.UNKNOWN_COLUMN, field })),
    ...parsed.malformed.map(({ line }) => ({ line, code: LINK_INPUT_PROBLEM.MALFORMED_ROW })),
  ];
  const rows: LinkRow[] = [];
  for (const { line, cells } of records) {
    for (const field of REQUIRED_COLUMNS) {
      if (columns.has(field) && cells[field] === undefined) {
        problems.push({ line, code: LINK_INPUT_PROBLEM.REQUIRED, field });
      }
    }
    rows.push({
      line,
      coordinatorEmail: (cells['coordinator_email'] ?? '').toLowerCase(),
      profileType: cells['profile_type'] ?? '',
      voiceBot: cells['voice_bot'] ?? '',
      linkName: cells['link_name'] ?? '',
      expiresOn: cells['expires_on'] ?? '',
    });
  }
  return { rows, problems };
}
