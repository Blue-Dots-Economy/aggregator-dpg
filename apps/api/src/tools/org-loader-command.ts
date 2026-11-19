/**
 * Commands of the org structure loader (`@aggregator-dpg/api`), run through
 * the `org-loader.ts` entry in the API pod. Runbook:
 * docs/org-structure-loader-runbook.md.
 *
 *   template --kind orgs|coordinators
 *   check  (--orgs <file|-> | --coordinators <file|->)...
 *   apply  (--orgs <file|-> | --coordinators <file|->)... --operator <name> [--report <file|->]
 *
 * `-` reads an input file from stdin (one input per run) or writes the report
 * to stdout. The report goes to stdout unless `--report <file>` names a new
 * file (for a local run). When it goes to stdout, stdout carries only the
 * report CSV and every other line goes to stderr. `template` prints one header line to stdout.
 * Output is counts, problem codes, field names and ids; names, emails and
 * phones appear only in the report. Exit codes: 0 ok, 1 refused or failed, 2 usage.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { UpstreamError, ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { config } from '../config.js';
import { closeDb } from '../db/client.js';
import { logger } from '../logger.js';
import { initRbac, stopRbacRefresh } from '../services/authz/runtime.js';
import { orgSchemaFields } from '../services/org-schema-validator.js';
import { provisionedBy } from '../services/provisioned.js';
import { closeRedis } from '../services/redis/index.js';
import { resolveSchema } from '../services/schema-ref.js';
import { csvField } from './csv-field.js';
import { applyLoadPlan, type ReportRow } from './org-loader-apply.js';
import {
  ADDRESS_PARTS,
  ADDRESS_PREFIX,
  ORG_FIXED_COLUMNS,
  parseCoordinatorsCsv,
  parseOrgsCsv,
  type CoordinatorRow,
  type InputProblem,
  type OrgRow,
} from './org-loader-input.js';
import { buildLoadPlan, type LoadPlan } from './org-loader-plan.js';

const log = logger.child({ operation: 'orgLoader' });

const USAGE =
  'usage: org-loader template --kind orgs|coordinators\n' +
  '       org-loader check [--orgs <file|->] [--coordinators <file|->]\n' +
  '       org-loader apply [--orgs <file|->] [--coordinators <file|->] --operator <name> [--report <file|->]\n' +
  '  - reads an input from stdin (one per run); the report goes to stdout unless --report names a file';

/** Exit codes: ok, refused or failed, usage. */
const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

/** The value meaning stdin (inputs) or stdout (report). */
const STDIO = '-';

/** Flags each command takes; every flag takes one value. */
const COMMAND_FLAGS = {
  template: ['--kind'],
  check: ['--orgs', '--coordinators'],
  apply: ['--orgs', '--coordinators', '--operator', '--report'],
} as const;

type Command = keyof typeof COMMAND_FLAGS;

/** Fixed columns of `coordinators.csv`, before the schema's own fields. */
const COORDINATOR_FIXED_COLUMNS = ['org', 'name', 'phone', 'email', 'profile_types'];

/**
 * Coordinator schema keys the loader fills itself (from the fixed columns) or never sends.
 * `url` belongs to the org: the accept route refuses it and the plan reports ORG_DETAILS_READ_ONLY.
 */
const COORDINATOR_FORM_KEYS: ReadonlySet<string> = new Set([
  'name',
  'url',
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

/** The process streams the commands use; tests pass their own. */
export interface LoaderIo {
  /** Reads all of stdin. */
  readStdin: () => Promise<string>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

/** Input for the plan, read from the files given. */
interface LoadInput {
  orgs: OrgRow[];
  /** The `orgs.csv` header columns; empty without an orgs file. */
  orgColumns: string[];
  coordinators: CoordinatorRow[];
  inputProblems: InputProblem[];
}

/** Prints one human-readable line. */
type Say = (line: string) => void;

/** A usage error: printed with the usage text, exit 2. */
class UsageError extends Error {}

/** Reads all of the process's stdin; refuses a terminal, which would wait forever. */
async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError('- reads the file from stdin: redirect it, e.g. `--orgs - < orgs.csv`');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const processIo: LoaderIo = {
  readStdin: readProcessStdin,
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
};

/**
 * Reads `--flag value` pairs, refusing anything the command does not take.
 *
 * @throws {UsageError} On an unknown or repeated flag, a stray argument or a missing value.
 */
function parseFlags(args: string[], allowed: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i] ?? '';
    if (!allowed.includes(name)) throw new UsageError(`unknown argument ${name}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${name} needs a value`);
    }
    if (flags.has(name)) throw new UsageError(`${name} given twice`);
    flags.set(name, value);
  }
  return flags;
}

/**
 * Renders the report CSV: a header of {@link REPORT_COLUMNS}, then one line per row.
 *
 * Holds names and emails; write it only to the operator's report file or stdout.
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

/** Reads one input: a file, or stdin for `-`. */
async function readInput(source: string, io: LoaderIo): Promise<string> {
  if (source === STDIO) return io.readStdin();
  try {
    return await readFile(source, 'utf8');
  } catch (err: unknown) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'error';
    throw new UsageError(`cannot read ${source} (${code})`);
  }
}

/** Reads and parses the inputs given; either may be absent, not both, and only one may be stdin. */
async function loadInput(
  orgs: string | undefined,
  coordinators: string | undefined,
  io: LoaderIo,
): Promise<LoadInput> {
  if (!orgs && !coordinators) throw new UsageError('give --orgs, --coordinators or both');
  if (orgs === STDIO && coordinators === STDIO) {
    throw new UsageError('only one input can be read from stdin; run orgs and coordinators apart');
  }
  const input: LoadInput = { orgs: [], orgColumns: [], coordinators: [], inputProblems: [] };
  if (orgs) {
    const parsed = parseOrgsCsv(await readInput(orgs, io));
    input.orgs = parsed.rows;
    input.orgColumns = parsed.columns;
    input.inputProblems.push(...parsed.problems);
  }
  if (coordinators) {
    const parsed = parseCoordinatorsCsv(await readInput(coordinators, io));
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
async function plan(input: LoadInput, say: Say): Promise<LoadPlan | null> {
  try {
    return await buildLoadPlan(input);
  } catch (err: unknown) {
    if (!(err instanceof UpstreamError)) throw err;
    const operation = err.details?.['operation'];
    say(
      `PLAN FAILED: ${err.code}${typeof operation === 'string' ? ` (${operation})` : ''} — nothing was written`,
    );
    return null;
  }
}

/** Labels for problem lines: the path given, or `<kind>(stdin)`. */
function inputLabels(
  orgs: string | undefined,
  coordinators: string | undefined,
): Record<InputProblem['file'], string> {
  const label = (kind: InputProblem['file'], source: string | undefined) =>
    source === undefined || source === STDIO ? `${kind}(stdin)` : source;
  return { orgs: label('orgs', orgs), coordinators: label('coordinators', coordinators) };
}

/** Prints the problems as `<file>:<line> <code> [<field>]`; never row data. */
function printProblems(
  problems: InputProblem[],
  labels: Record<InputProblem['file'], string>,
  say: Say,
): void {
  for (const p of problems) {
    say(`${labels[p.file]}:${p.line} ${p.code}${p.field ? ` ${p.field}` : ''}`);
  }
}

/** Formats counts as `key=n key=n`. */
function counts(by: Record<string, number>): string {
  return Object.entries(by)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
}

/** Prints how many orgs and coordinators the plan creates, resumes and skips. */
function printPlanCounts(p: LoadPlan, say: Say): void {
  const byAction = (actions: string[]) => {
    const by: Record<string, number> = { create: 0, resume: 0, already_loaded: 0 };
    for (const a of actions) by[a] = (by[a] ?? 0) + 1;
    return counts(by);
  };
  say(`  orgs: ${byAction(p.orgs.map((o) => o.action))}`);
  say(`  coordinators: ${byAction(p.coordinators.map((c) => c.action))}`);
}

/** `check` and `apply`. */
async function checkOrApply(
  command: 'check' | 'apply',
  args: string[],
  io: LoaderIo,
): Promise<number> {
  const flags = parseFlags(args, COMMAND_FLAGS[command]);
  const orgs = flags.get('--orgs');
  const coordinators = flags.get('--coordinators');
  // The report defaults to stdout: a file written in the pod would be lost with it.
  const reportToStdout = command === 'apply' && (flags.get('--report') ?? STDIO) === STDIO;
  const say: Say = (line) => (reportToStdout ? io.writeStderr : io.writeStdout)(`${line}\n`);

  let operator = '';
  let reportFile = '';
  if (command === 'apply') {
    operator = flags.get('--operator') ?? '';
    if (!operator) throw new UsageError('apply needs --operator <name>');
    try {
      provisionedBy(operator);
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw new UsageError(`--operator: ${err.message}`);
      throw err;
    }
    reportFile = flags.get('--report') ?? STDIO;
    if (!reportToStdout && existsSync(reportFile)) {
      throw new UsageError(`report file ${reportFile} already exists`);
    }
  }
  const input = await loadInput(orgs, coordinators, io);
  const labels = inputLabels(orgs, coordinators);

  say(`org-loader ${command}${operator ? ` as ${provisionedBy(operator)}` : ''}`);
  say(`  rows: orgs=${input.orgs.length} coordinators=${input.coordinators.length}`);
  const p = await plan(input, say);
  if (!p) return EXIT.FAILED;
  printProblems(p.problems, labels, say);
  printPlanCounts(p, say);
  if (p.problems.length > 0) {
    say(
      `${command === 'check' ? 'CHECK FAILED' : 'REFUSED'} — ${p.problems.length} problem(s); nothing was written`,
    );
    return EXIT.FAILED;
  }
  if (command === 'check') {
    say('CHECK PASSED — ready for apply');
    return EXIT.OK;
  }
  return apply(p, operator, reportToStdout ? null : reportFile, labels, io, say);
}

/**
 * Applies a checked plan and writes the report.
 *
 * @param reportFile - The report path, or `null` to write the report to stdout.
 */
async function apply(
  p: LoadPlan,
  operator: string,
  reportFile: string | null,
  labels: Record<InputProblem['file'], string>,
  io: LoaderIo,
  say: Say,
): Promise<number> {
  // Role syncs are awaited per account; they are real only with the runtime loaded. No refresh timer: the run is short.
  await initRbac(config.RBAC_MODE, 0);
  let result: Awaited<ReturnType<typeof applyLoadPlan>>;
  try {
    result = await applyLoadPlan(p, { operator, log });
  } finally {
    stopRbacRefresh();
  }
  const csv = reportCsv(result.rows);
  if (reportFile) await writeFile(reportFile, csv, { flag: 'wx', mode: 0o600 });
  else io.writeStdout(csv);
  const by: Record<string, number> = {};
  for (const r of result.rows) by[r.outcome] = (by[r.outcome] ?? 0) + 1;
  say(`  outcomes: ${counts(by)}`);
  say(`  report: ${reportFile ?? 'stdout'}`);
  const failed = result.rows.find((r) => r.outcome === 'failed');
  if (failed) {
    say(
      `APPLY FAILED at ${labels[failed.kind === 'org' ? 'orgs' : 'coordinators']}:${failed.line} ` +
        `${failed.errorCode ?? 'error'} — fix the cause and run apply again; loaded rows are skipped`,
    );
    return EXIT.FAILED;
  }
  say('APPLY COMPLETE');
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

/** `template --kind orgs|coordinators`: prints that file's header line to stdout. */
async function template(args: string[], io: LoaderIo): Promise<number> {
  const kind = parseFlags(args, COMMAND_FLAGS.template).get('--kind');
  if (kind !== 'orgs' && kind !== 'coordinators') {
    throw new UsageError('template needs --kind orgs or --kind coordinators');
  }
  const columns = await templateColumns();
  io.writeStdout(`${columns[kind].map(csvField).join(',')}\n`);
  return EXIT.OK;
}

/** Whether `value` names a command. */
function isCommand(value: string | undefined): value is Command {
  return value !== undefined && Object.hasOwn(COMMAND_FLAGS, value);
}

/**
 * Runs one command.
 *
 * @param argv - The command and its flags.
 * @param io - The process streams; tests pass their own.
 * @returns The exit code: 0 ok, 1 refused or failed, 2 usage.
 * @throws {Error} When the network config or a schema cannot be loaded, or an unexpected error occurs.
 */
async function main(argv: string[], io: LoaderIo = processIo): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (!isCommand(command))
      throw new UsageError(command ? `unknown command ${command}` : 'no command');
    if (command === 'template') return await template(args, io);
    return await checkOrApply(command, args, io);
  } catch (err: unknown) {
    if (!(err instanceof UsageError)) throw err;
    io.writeStderr(`usage error: ${err.message}\n${USAGE}\n`);
    return EXIT.USAGE;
  }
}

/**
 * Runs the command for the process entry: logs an unexpected error, then closes the connections the run opened.
 *
 * @param argv - The command and its flags.
 * @returns The exit code.
 */
export async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err: unknown) {
    log.error({
      status: 'failure',
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      code: err instanceof UpstreamError || err instanceof ValidationError ? err.code : undefined,
    });
    process.stderr.write('FAILED — unexpected error; see the log line above\n');
    return EXIT.FAILED;
  } finally {
    stopRbacRefresh();
    await Promise.allSettled([closeDb(), closeRedis()]);
  }
}

/**
 * Runs one command and returns its exit code. Exported for tests.
 *
 * @throws {Error} When the network config or a schema cannot be loaded, or an unexpected error occurs.
 */
export { main as _main };
