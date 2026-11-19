/**
 * Commands of the QR links loader (`@aggregator-dpg/api`), run through the
 * `qr-links.ts` entry in the API pod:
 *
 *   check --links - [--operator <name>]
 *   apply --links - --operator <name>
 *
 * The links sheet is read from stdin only. `apply` writes the report CSV to
 * stdout, and stdout carries nothing else; every other line goes to stderr.
 * Output is counts, problem codes, field names and line numbers; emails
 * appear only in the report. Exit codes: 0 ok, 1 refused or failed, 2 usage.
 */

import { UpstreamError, ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { config } from '../config.js';
import { closeDb } from '../db/client.js';
import { logger } from '../logger.js';
import { provisionedBy } from '../services/provisioned.js';
import { closeRedis } from '../services/redis/index.js';
import { withTimeout } from './call-timeout.js';
import { csvField } from './csv-field.js';
import { applyLinksPlan, type LinkReportRow } from './qr-links-apply.js';
import { parseLinksCsv } from './qr-links-input.js';
import { buildLinksPlan } from './qr-links-plan.js';

const log = logger.child({ operation: 'qrLinks' });

const USAGE =
  'usage: qr-links check --links - [--operator <name>] < links.csv\n' +
  '       qr-links apply --links - --operator <name> < links.csv > report.csv\n' +
  '  the links sheet is read from stdin; the apply report goes to stdout';

/** Exit codes: ok, refused or failed, usage. */
const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

/** The only `--links` value: stdin. */
const STDIN = '-';

/** Flags each command takes; every flag takes one value. */
const COMMAND_FLAGS = {
  check: ['--links', '--operator'],
  apply: ['--links', '--operator'],
} as const;

type Command = keyof typeof COMMAND_FLAGS;

/** Report columns, in the spec's order, each with the {@link LinkReportRow} field it shows. */
const REPORT_FIELDS = [
  ['line', 'line'],
  ['coordinator_email', 'coordinatorEmail'],
  ['profile_type', 'profileType'],
  ['voice_bot', 'voiceBot'],
  ['slug', 'slug'],
  ['url', 'url'],
  ['outcome', 'outcome'],
  ['error_code', 'errorCode'],
] as const satisfies readonly (readonly [string, keyof LinkReportRow])[];

/** The report CSV header columns. */
export const LINK_REPORT_COLUMNS: readonly string[] = REPORT_FIELDS.map(([column]) => column);

type AssertNever<T extends never> = T;
/** Fails to compile when a {@link LinkReportRow} field has no report column. */
export type LinkReportFieldsCovered = AssertNever<
  Exclude<keyof LinkReportRow, (typeof REPORT_FIELDS)[number][1]>
>;

/** The process streams the commands use; tests pass their own. */
export interface QrLinksIo {
  /** Reads all of stdin. */
  readStdin: () => Promise<string>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

/** A usage error: printed with the usage text, exit 2. */
class UsageError extends Error {}

/** Reads all of the process's stdin; refuses a terminal, which would wait forever. */
async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError('--links - reads the sheet from stdin: redirect it, e.g. `< links.csv`');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const processIo: QrLinksIo = {
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
 * Renders the report CSV: a header of {@link LINK_REPORT_COLUMNS}, then one line per row.
 *
 * Holds coordinator emails; write it only to stdout for the operator.
 *
 * @param rows - The report rows, in sheet order.
 * @returns The CSV text.
 */
export function linksReportCsv(rows: LinkReportRow[]): string {
  const lines = [LINK_REPORT_COLUMNS.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(REPORT_FIELDS.map(([, key]) => csvField(String(row[key]))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Checks the operator name.
 *
 * @returns The `provisioned:<operator>` label.
 * @throws {UsageError} When the name is invalid.
 */
function operatorLabel(operator: string): string {
  try {
    return provisionedBy(operator);
  } catch (err: unknown) {
    if (err instanceof ValidationError) throw new UsageError(`--operator: ${err.message}`);
    throw err;
  }
}

/** Formats counts as `key=n key=n`. */
function counts(by: Record<string, number>): string {
  return Object.entries(by)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
}

/** `check` and `apply`. */
async function checkOrApply(command: Command, args: string[], io: QrLinksIo): Promise<number> {
  const flags = parseFlags(args, COMMAND_FLAGS[command]);
  const links = flags.get('--links');
  if (links !== STDIN) throw new UsageError('give --links - and redirect the sheet to stdin');
  const operator = flags.get('--operator');
  if (command === 'apply' && !operator) throw new UsageError('apply needs --operator <name>');
  const label = operator === undefined ? '' : operatorLabel(operator);
  const say = (line: string): void => io.writeStderr(`${line}\n`);

  const parsed = parseLinksCsv(await io.readStdin());
  say(`qr-links ${command}${label ? ` as ${label}` : ''}`);
  say(`  rows: ${parsed.rows.length}`);
  const callTimeoutMs = config.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS;
  const plan = await buildLinksPlan({
    rows: parsed.rows,
    inputProblems: parsed.problems,
    callTimeoutMs,
  });
  for (const p of plan.problems) say(`${p.line} ${p.code}${p.field ? ` ${p.field}` : ''}`);
  const existing = plan.links.filter((l) => l.existing !== null).length;
  say(`  links: create=${plan.links.length - existing} already_loaded=${existing}`);
  if (plan.problems.length > 0) {
    say(
      `${command === 'check' ? 'CHECK FAILED' : 'REFUSED'} — ${plan.problems.length} problem(s); nothing was written`,
    );
    return EXIT.FAILED;
  }
  if (command === 'check') {
    say('CHECK PASSED — ready for apply');
    return EXIT.OK;
  }

  const result = await applyLinksPlan(plan, { operator: operator ?? '', log, callTimeoutMs });
  io.writeStdout(linksReportCsv(result.rows));
  const by: Record<string, number> = {};
  for (const r of result.rows) by[r.outcome] = (by[r.outcome] ?? 0) + 1;
  say(`  outcomes: ${counts(by)}`);
  const failed = result.rows.find((r) => r.outcome === 'failed');
  if (failed) {
    say(
      `APPLY FAILED at line ${failed.line} ${failed.errorCode} — fix the cause and run apply again; loaded rows are skipped`,
    );
    return EXIT.FAILED;
  }
  say('APPLY COMPLETE');
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
 * @throws {Error} When the network config cannot be loaded, or an unexpected error occurs.
 */
async function main(argv: string[], io: QrLinksIo = processIo): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (!isCommand(command)) {
      throw new UsageError(command ? `unknown command ${command}` : 'no command');
    }
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
    const closing = Promise.allSettled([closeDb(), closeRedis()]);
    await withTimeout(closing, config.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS, 'shutdown').catch(
      (err: unknown) => {
        log.warn({ status: 'failure', step: 'shutdown', error_type: errorType(err) });
      },
    );
  }
}

/** The error's class name, for logs. */
function errorType(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

/**
 * Runs one command and returns its exit code. Exported for tests.
 *
 * @throws {Error} When the network config cannot be loaded, or an unexpected error occurs.
 */
export { main as _main };
