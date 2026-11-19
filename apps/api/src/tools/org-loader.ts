/**
 * Org structure loader operator command (`@aggregator-dpg/api`). Runbook:
 * docs/org-structure-loader-runbook.md. Shipped in the API image and run in
 * the API pod with the API's ConfigMap and Secret:
 *
 *   node dist/tools/org-loader.js template --out <dir>
 *   node dist/tools/org-loader.js check [--orgs <file>] [--coordinators <file>]
 *   node dist/tools/org-loader.js apply [--orgs <file>] [--coordinators <file>] --operator <name> [--report <file>]
 *
 * `template` writes the two CSV headers for this instance's schemas. `check`
 * plans the load and prints every problem, writing nothing. `apply` runs the
 * same checks, refuses on any problem, then creates and approves the orgs and
 * coordinators and writes a report CSV. Output is counts, problem codes, field
 * names and ids; names, emails and phones appear only in the report file.
 * Exit codes: 0 ok, 1 refused or failed, 2 usage.
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UpstreamError, ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { config } from '../config.js';
import { closeDb } from '../db/client.js';
import { logger } from '../logger.js';
import { initRbac, stopRbacRefresh } from '../services/authz/runtime.js';
import { orgSchemaFields } from '../services/org-schema-validator.js';
import { provisionedBy } from '../services/provisioned.js';
import { closeRedis } from '../services/redis/index.js';
import { resolveSchema } from '../services/schema-ref.js';
import { applyLoadPlan, type ReportRow } from './org-loader-apply.js';
import {
  ADDRESS_PARTS,
  ADDRESS_PREFIX,
  parseCoordinatorsCsv,
  parseOrgsCsv,
  type CoordinatorRow,
  type InputProblem,
  type OrgRow,
} from './org-loader-input.js';
import { buildLoadPlan, type LoadPlan } from './org-loader-plan.js';

const log = logger.child({ operation: 'orgLoader' });

const USAGE =
  'usage: org-loader template --out <dir>\n' +
  '       org-loader check [--orgs <file>] [--coordinators <file>]\n' +
  '       org-loader apply [--orgs <file>] [--coordinators <file>] --operator <name> [--report <file>]';

/** Exit codes: ok, refused or failed, usage. */
const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

/** Fixed columns of `orgs.csv`, before the schema's own fields. */
const ORG_FIXED_COLUMNS = ['name', 'parent', 'owner_name', 'owner_phone', 'owner_email'];

/** Fixed columns of `coordinators.csv`, before the schema's own fields. */
const COORDINATOR_FIXED_COLUMNS = ['org', 'name', 'phone', 'email', 'profile_types'];

/** Coordinator schema keys the loader fills itself (from the fixed columns) or never sends. */
const COORDINATOR_FORM_KEYS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'contact',
  'locations',
  'consent',
  'invite',
]);

/** The coordinator registration schema file. */
const COORDINATOR_SCHEMA_FILE = 'registration.v1.json';

/** Report columns: every {@link ReportRow} field, in the order the spec lists them. */
export const REPORT_COLUMNS = [
  'kind',
  'line',
  'name',
  'email',
  'outcome',
  'orgId',
  'userId',
  'signalsOrgId',
  'rolesSync',
  'errorCode',
] as const satisfies readonly (keyof ReportRow)[];

type AssertNever<T extends never> = T;
/** Fails to compile when a {@link ReportRow} field has no column in {@link REPORT_COLUMNS}. */
export type ReportColumnsCoverReportRow = AssertNever<
  Exclude<keyof ReportRow, (typeof REPORT_COLUMNS)[number]>
>;

/** Input for the plan, read from the files given. */
interface LoadInput {
  orgs: OrgRow[];
  coordinators: CoordinatorRow[];
  inputProblems: InputProblem[];
}

/** A usage error: printed with the usage text, exit 2. */
class UsageError extends Error {}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The value after `name`, or `undefined` when absent or followed by another flag. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/**
 * Neutralises spreadsheet formula injection: a cell starting with `=`, `+`,
 * `-`, `@`, TAB or CR gets a leading single quote. Same rule as `profile-csv`.
 */
function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** One CSV field: formula-neutralised, then RFC 4180 quoted when needed. */
function csvField(value: string): string {
  const safe = neutraliseFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * Renders the report CSV: a header of {@link REPORT_COLUMNS}, then one line per row.
 *
 * Holds names and emails; write it only to the operator's report file.
 *
 * @param rows - The report rows, in apply order.
 * @returns The CSV text.
 */
export function reportCsv(rows: ReportRow[]): string {
  const lines = [REPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(REPORT_COLUMNS.map((c) => csvField(String(row[c] ?? ''))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** The default report path: `org-loader-report-<ISO time>.csv`, with `:` and `.` as `-` so `kubectl cp` takes it. */
function defaultReportPath(): string {
  return `org-loader-report-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
}

/** Reads one input file. */
async function readInput(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err: unknown) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'error';
    throw new UsageError(`cannot read ${file} (${code})`);
  }
}

/** Reads and parses the files given; either may be absent, not both. */
async function loadInput(
  orgsFile: string | undefined,
  coordinatorsFile: string | undefined,
): Promise<LoadInput> {
  if (!orgsFile && !coordinatorsFile) {
    throw new UsageError('give --orgs, --coordinators or both');
  }
  const input: LoadInput = { orgs: [], coordinators: [], inputProblems: [] };
  if (orgsFile) {
    const parsed = parseOrgsCsv(await readInput(orgsFile));
    input.orgs = parsed.rows;
    input.inputProblems.push(...parsed.problems);
  }
  if (coordinatorsFile) {
    const parsed = parseCoordinatorsCsv(await readInput(coordinatorsFile));
    input.coordinators = parsed.rows;
    input.inputProblems.push(...parsed.problems);
  }
  return input;
}

/**
 * Builds the plan. A failed lookup prints its code and operation.
 *
 * @returns The plan, or `null` when a lookup failed.
 */
async function plan(input: LoadInput): Promise<LoadPlan | null> {
  try {
    return await buildLoadPlan(input);
  } catch (err: unknown) {
    if (!(err instanceof UpstreamError)) throw err;
    const operation = err.details?.['operation'];
    out(
      `PLAN FAILED: ${err.code}${typeof operation === 'string' ? ` (${operation})` : ''} — nothing was written`,
    );
    return null;
  }
}

/** Prints the problems as `<file>:<line> <code> [<field>]`; never row data. */
function printProblems(
  problems: InputProblem[],
  files: Record<InputProblem['file'], string>,
): void {
  for (const p of problems) {
    out(`${files[p.file]}:${p.line} ${p.code}${p.field ? ` ${p.field}` : ''}`);
  }
}

/** Prints how many orgs and coordinators the plan creates, resumes and skips. */
function printPlanCounts(p: LoadPlan): void {
  const count = (actions: string[]) => {
    const by: Record<string, number> = { create: 0, resume: 0, already_loaded: 0 };
    for (const a of actions) by[a] = (by[a] ?? 0) + 1;
    return Object.entries(by)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
  };
  out(`  orgs: ${count(p.orgs.map((o) => o.action))}`);
  out(`  coordinators: ${count(p.coordinators.map((c) => c.action))}`);
}

/** `check` and `apply`. */
async function checkOrApply(command: 'check' | 'apply', args: string[]): Promise<number> {
  const orgsFile = flag(args, '--orgs');
  const coordinatorsFile = flag(args, '--coordinators');
  let operator = '';
  let decidedBy = '';
  let reportFile = '';
  if (command === 'apply') {
    operator = flag(args, '--operator') ?? '';
    if (!operator) throw new UsageError('apply needs --operator <name>');
    try {
      decidedBy = provisionedBy(operator);
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw new UsageError(`--operator: ${err.message}`);
      throw err;
    }
    reportFile = flag(args, '--report') ?? defaultReportPath();
    if (existsSync(reportFile)) throw new UsageError(`report file ${reportFile} already exists`);
  }
  const input = await loadInput(orgsFile, coordinatorsFile);
  const files = { orgs: orgsFile ?? 'orgs', coordinators: coordinatorsFile ?? 'coordinators' };

  out(`org-loader ${command}${decidedBy ? ` as ${decidedBy}` : ''}`);
  out(`  rows: orgs=${input.orgs.length} coordinators=${input.coordinators.length}`);
  const p = await plan(input);
  if (!p) return EXIT.FAILED;
  printProblems(p.problems, files);
  printPlanCounts(p);
  if (p.problems.length > 0) {
    out(
      `${command === 'check' ? 'CHECK FAILED' : 'REFUSED'} — ${p.problems.length} problem(s); nothing was written`,
    );
    return EXIT.FAILED;
  }
  if (command === 'check') {
    out('CHECK PASSED — ready for apply');
    return EXIT.OK;
  }
  return apply(p, operator, reportFile, files);
}

/** Applies a checked plan and writes the report. */
async function apply(
  p: LoadPlan,
  operator: string,
  reportFile: string,
  files: Record<InputProblem['file'], string>,
): Promise<number> {
  // Role syncs are awaited per account; they are real only with the runtime loaded. No refresh timer: the run is short.
  await initRbac(config.RBAC_MODE, 0);
  let result: Awaited<ReturnType<typeof applyLoadPlan>>;
  try {
    result = await applyLoadPlan(p, { operator, log });
  } finally {
    stopRbacRefresh();
  }
  await writeFile(reportFile, reportCsv(result.rows), { flag: 'wx', mode: 0o600 });
  const by: Record<string, number> = {};
  for (const r of result.rows) by[r.outcome] = (by[r.outcome] ?? 0) + 1;
  out(
    `  outcomes: ${Object.entries(by)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')}`,
  );
  out(`  report: ${reportFile}`);
  const failed = result.rows.find((r) => r.outcome === 'failed');
  if (failed) {
    out(
      `APPLY FAILED at ${files[failed.kind === 'org' ? 'orgs' : 'coordinators']}:${failed.line} ` +
        `${failed.errorCode ?? 'error'} — fix the cause and run apply again; loaded rows are skipped`,
    );
    return EXIT.FAILED;
  }
  out('APPLY COMPLETE');
  return EXIT.OK;
}

/**
 * The template headers for this instance: the fixed columns, then every schema
 * field that is not a fixed key or `consent`, then (orgs) the address columns.
 *
 * @returns The `orgs.csv` and `coordinators.csv` columns.
 * @throws {Error} When a registration schema cannot be found.
 */
export async function templateColumns(): Promise<{ orgs: string[]; coordinators: string[] }> {
  const coordinatorSchema = resolveSchema(COORDINATOR_SCHEMA_FILE);
  if (!coordinatorSchema) throw new Error(`${COORDINATOR_SCHEMA_FILE} not found`);
  const raw: unknown = JSON.parse(await readFile(coordinatorSchema.path, 'utf8'));
  const properties =
    typeof raw === 'object' && raw !== null && 'properties' in raw ? raw.properties : null;
  const coordinatorFields =
    typeof properties === 'object' && properties !== null ? Object.keys(properties) : [];
  return {
    orgs: [
      ...ORG_FIXED_COLUMNS,
      ...(await orgSchemaFields()),
      ...ADDRESS_PARTS.map((part) => `${ADDRESS_PREFIX}${part}`),
    ],
    coordinators: [
      ...COORDINATOR_FIXED_COLUMNS,
      ...coordinatorFields.filter((k) => !COORDINATOR_FORM_KEYS.has(k)),
    ],
  };
}

/** `template`: writes `orgs.csv` and `coordinators.csv` headers into `--out`. */
async function template(args: string[]): Promise<number> {
  const dir = flag(args, '--out');
  if (!dir) throw new UsageError('template needs --out <dir>');
  const columns = await templateColumns();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'orgs.csv'), `${columns.orgs.map(csvField).join(',')}\n`);
  await writeFile(
    path.join(dir, 'coordinators.csv'),
    `${columns.coordinators.map(csvField).join(',')}\n`,
  );
  out(
    `template: ${path.join(dir, 'orgs.csv')} (${columns.orgs.length} columns), ` +
      `${path.join(dir, 'coordinators.csv')} (${columns.coordinators.length} columns)`,
  );
  return EXIT.OK;
}

/**
 * Runs one command.
 *
 * @param argv - The command and its flags.
 * @returns The exit code: 0 ok, 1 refused or failed, 2 usage.
 * @throws {Error} When the network config or a schema cannot be loaded, or an unexpected error occurs.
 */
async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === 'template') return await template(args);
    if (command === 'check' || command === 'apply') return await checkOrApply(command, args);
    out(USAGE);
    return EXIT.USAGE;
  } catch (err: unknown) {
    if (!(err instanceof UsageError)) throw err;
    out(`usage error: ${err.message}`);
    out(USAGE);
    return EXIT.USAGE;
  }
}

/** Closes the connections the run opened, so the process exits. */
async function shutdown(): Promise<void> {
  stopRbacRefresh();
  await Promise.allSettled([closeDb(), closeRedis()]);
}

/** Whether this module is the process entry, including through a symlink. */
function isEntry(): boolean {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url;
  } catch {
    // No path (e.g. `node -e`): not the entry.
    return false;
  }
}

if (isEntry()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err: unknown) {
    log.error({
      status: 'failure',
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      code: err instanceof UpstreamError || err instanceof ValidationError ? err.code : undefined,
    });
    out('FAILED — unexpected error; see the log line above');
    process.exitCode = EXIT.FAILED;
  } finally {
    await shutdown();
  }
}

/**
 * Runs one command and returns its exit code. Exported for tests.
 *
 * @throws {Error} When the network config or a schema cannot be loaded, or an unexpected error occurs.
 */
export { main as _main };
