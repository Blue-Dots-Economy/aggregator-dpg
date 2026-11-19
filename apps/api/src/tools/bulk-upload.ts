/**
 * Bulk-upload operator command (`@aggregator-dpg/api`). Runs a bulk upload on
 * a coordinator's behalf, without the coordinator signing in, through the same
 * create and start steps as a portal upload (`services/bulk-upload/`).
 * Shipped in the API image and run in the API pod; runbook:
 * docs/bulk-upload-command-runbook.md.
 *
 *   node dist/tools/bulk-upload.js --coordinator <email or user id> --type <profile type> \
 *     --file - --operator <name> [--skip-rate-limit] < file.csv
 *   node dist/tools/bulk-upload.js --coordinator <email or user id> --upload-id <id> [--errors-csv]
 *
 * The CSV is read from stdin; `--file` takes only `-`. The second form waits for an upload and
 * prints its result, or with `--errors-csv` writes its errors report to stdout.
 * Messages and logs go to stderr. The operator is recorded in the logs only.
 * Exit codes: 0 ok, 1 refused or failed, 2 usage.
 */

import './log-to-stderr.js';
import '../env.js';
import { existsSync, realpathSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Papa from 'papaparse';
import {
  getObjectStorage,
  initObjectStorage,
  type ObjectRef,
} from '@aggregator-dpg/object-storage';
import {
  bulkHeaderColumns,
  checkBulkHeader,
  CSV_FIELD_DELIMITER,
  normaliseHeaderCells,
} from '@aggregator-dpg/shared-primitives/bulk-columns';
import { errorMessage } from '@aggregator-dpg/shared-primitives/errors';
import { config } from '../config.js';
import { HttpError } from '../errors/http-error.js';
import { logger } from '../logger.js';
import {
  deleteRejectedUpload,
  reserveBulkUpload,
  saveStorageKey,
  startBulkUpload,
} from '../services/bulk-upload/index.js';
import { loadCounts } from '../services/bulk-upload/counts.js';
import { checkBulkUploadRate } from '../services/bulk-upload-rate.js';
import { getBulkUploadsStore } from '../services/bulk-uploads-store/index.js';
import type { BulkUpload, BulkUploadStatus } from '../services/bulk-uploads-store/interface.js';
import { getIdentityStore } from '../services/identity-store/index.js';
import { IDP_PROVIDER } from '../services/idp-admin/provider.js';
import { provisionedBy } from '../services/provisioned.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { getUserStore, type Coordinator } from '../services/user-store/index.js';

const USAGE = [
  'usage: bulk-upload --coordinator <email or user id> --type <profile type> --file - --operator <name> [--skip-rate-limit] < file.csv',
  '       bulk-upload --coordinator <email or user id> --upload-id <id> [--errors-csv]',
].join('\n');

/** How often the upload status is read while waiting. */
const POLL_INTERVAL_MS = 5_000;

/** A user id or upload id; any other `--coordinator` value is looked up as an email. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Upload statuses the worker never leaves; waiting stops at one of them. */
const TERMINAL: ReadonlySet<BulkUploadStatus> = new Set(['completed', 'failed', 'file_failed']);

/** A refusal. Printed as `REFUSED: …` with exit code 1. */
class Refusal extends Error {}

/** A usage error. Printed with the usage text and exit code 2. */
class UsageError extends Error {}

/** What the command reads from and writes to; tests replace them. */
export interface CommandIo {
  /** One line of human-readable output. */
  out: (line: string) => void;
  /** Where `--errors-csv` writes the report. */
  csvOut: Writable;
  stdin: Readable;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  callTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** Rejects when `promise` takes longer than `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the CSV from stdin, refusing more than the upload limit. */
async function readCsv(stdin: Readable): Promise<Buffer> {
  const max = config.BULK_UPLOAD_MAX_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > max) throw new Refusal(`the file is larger than ${max} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Finds the coordinator by user id or email and requires it to be active. */
async function activeCoordinator(ref: string, io: CommandIo): Promise<Coordinator> {
  const store = getUserStore();
  const lookup = UUID_RE.test(ref) ? store.findById(ref) : store.findByContactEmail(ref);
  const found = await withTimeout(lookup, io.callTimeoutMs, 'coordinator lookup');
  if (!found.ok) throw new Error(found.error.message);
  if (!found.value) throw new Refusal('no coordinator with that email or user id');
  if (found.value.status !== 'active') {
    throw new Refusal(`coordinator ${found.value.id} is ${found.value.status}, not active`);
  }
  return found.value;
}

/** The coordinator's Keycloak subject, which a portal upload stores as `uploaded_by`. */
async function keycloakSubject(coordinatorId: string, io: CommandIo): Promise<string> {
  const subject = await withTimeout(
    getIdentityStore().subjectOf(coordinatorId, IDP_PROVIDER),
    io.callTimeoutMs,
    'login lookup',
  );
  if (!subject.ok) throw new Error(subject.error.message);
  if (!subject.value) {
    throw new Refusal(`coordinator ${coordinatorId} has no recorded Keycloak login`);
  }
  return subject.value;
}

/**
 * The CSV's header cells, read as the worker reads them: strict UTF-8 with a
 * byte-order mark dropped, `,` as the delimiter, the first non-empty record,
 * each cell trimmed.
 *
 * @throws {Refusal} When the file is not valid UTF-8.
 */
function headerCells(body: Buffer): string[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new Refusal('the file is not valid UTF-8');
  }
  let first: unknown[] = [];
  // `preview` counts skipped blank lines, so stop at the first kept record instead.
  Papa.parse<unknown[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: CSV_FIELD_DELIMITER,
    step: (row, parser) => {
      first = row.data;
      parser.abort();
    },
  });
  return normaliseHeaderCells(first);
}

/**
 * Refuses a header the worker would reject: a required column missing, or a
 * column the participant schema does not declare.
 *
 * @throws {Refusal} When the header or its encoding would fail the file.
 */
async function requireValidHeader(type: string, body: Buffer, io: CommandIo): Promise<void> {
  const loaded = await withTimeout(
    getSchemaLoader().getSchema({ id: `participant-${type}`, version: 'v1' }),
    io.callTimeoutMs,
    'schema load',
  );
  if (!loaded.success) throw new Error(`participant schema unavailable: ${loaded.error.message}`);
  const problem = checkBulkHeader(headerCells(body), bulkHeaderColumns(loaded.value));
  if (problem) throw new Refusal(`${problem.kind} columns: ${problem.columns.join(', ')}`);
}

/** Reads one upload row. */
async function readUpload(
  uploadId: string,
  coordinatorId: string,
  io: CommandIo,
): Promise<BulkUpload> {
  const found = await withTimeout(
    getBulkUploadsStore().findById(uploadId, coordinatorId),
    io.callTimeoutMs,
    'upload status read',
  );
  if (!found.ok) throw new Error(found.error.message);
  if (!found.value) throw new Refusal(`upload ${uploadId} is not this coordinator's`);
  return found.value;
}

/** Reads the upload until it reaches a final status or the wait runs out. */
async function waitForResult(
  uploadId: string,
  coordinatorId: string,
  io: CommandIo,
): Promise<BulkUpload | null> {
  const deadline = Date.now() + io.pollTimeoutMs;
  let last: BulkUploadStatus | null = null;
  for (;;) {
    const upload = await readUpload(uploadId, coordinatorId, io);
    if (TERMINAL.has(upload.status)) return upload;
    if (upload.status !== last) {
      last = upload.status;
      io.out(`  ${last}…`);
    }
    if (Date.now() >= deadline) return null;
    await io.sleep(io.pollIntervalMs);
  }
}

/** Prints the final status and counts; exit code 0 only for `completed`. */
async function report(upload: BulkUpload, io: CommandIo): Promise<number> {
  io.out(`status: ${upload.status}${upload.statusReason ? ` (${upload.statusReason})` : ''}`);
  if (upload.status !== 'completed') return 1;
  const counts = await withTimeout(
    loadCounts(upload.id, upload.status),
    io.callTimeoutMs,
    'counts read',
  );
  io.out(
    `rows: ${counts.totalRows ?? '?'} total, ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`,
  );
  if (upload.errorsCsvStorageKey) {
    io.out(`errors report: --upload-id ${upload.id} --errors-csv > errors.csv`);
  }
  return 0;
}

/** Writes the upload's errors report, and nothing else, to `io.csvOut`. */
async function writeErrorsCsv(upload: BulkUpload, io: CommandIo): Promise<number> {
  if (upload.status !== 'completed') {
    throw new Refusal(`upload ${upload.id} is ${upload.status}; the report exists once completed`);
  }
  if (!upload.errorsCsvStorageKey) throw new Refusal('no errors report: every row passed');
  const stream = await withTimeout(
    getObjectStorage().openReadStream({ area: 'bulk-uploads', key: upload.errorsCsvStorageKey }),
    io.callTimeoutMs,
    'errors report read',
  );
  if (!stream.success) throw stream.error;
  if (!stream.value) throw new Refusal('the errors report is no longer available');
  await pipeline(stream.value, io.csvOut, { end: false });
  return 0;
}

/** Waits for (or reads) an earlier upload: the `--upload-id` form. */
async function followUp(
  coordinatorRef: string,
  uploadId: string,
  errorsCsv: boolean,
  io: CommandIo,
): Promise<number> {
  const coordinator = await activeCoordinator(coordinatorRef, io);
  if (errorsCsv) return writeErrorsCsv(await readUpload(uploadId, coordinator.id, io), io);
  const done = await waitForResult(uploadId, coordinator.id, io);
  if (!done) {
    io.out(`upload ${uploadId} is still processing`);
    return 1;
  }
  return report(done, io);
}

/** Deletes the stored CSV of an upload that failed before it was marked uploaded. */
async function discardIfNotStarted(
  uploadId: string,
  coordinatorId: string,
  ref: ObjectRef,
  log: typeof logger,
  io: CommandIo,
): Promise<void> {
  try {
    const upload = await readUpload(uploadId, coordinatorId, io);
    if (upload.status === 'pending') await deleteRejectedUpload(ref, log);
  } catch (err) {
    log.warn({ status: 'failure', sub_operation: 'discard', error: errorMessage(err) });
  }
}

/**
 * Parses the flags.
 *
 * @throws {UsageError} On an unknown or malformed flag.
 */
function parseFlags(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        coordinator: { type: 'string' },
        type: { type: 'string' },
        file: { type: 'string' },
        operator: { type: 'string' },
        'skip-rate-limit': { type: 'boolean', default: false },
        'upload-id': { type: 'string' },
        'errors-csv': { type: 'boolean', default: false },
      },
      strict: true,
    }).values;
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
}

/** Parsed command-line flags. */
type Flags = ReturnType<typeof parseFlags>;

/** Runs a new upload: the first form of the command. */
async function upload(values: Flags, coordinatorRef: string, io: CommandIo): Promise<number> {
  const { type, file, operator } = values;
  if (!type || !file || !operator) {
    throw new UsageError('--type, --file and --operator are required');
  }
  if (file !== '-') throw new UsageError('--file must be - (the CSV is read from stdin)');
  try {
    provisionedBy(operator);
  } catch {
    throw new UsageError('--operator must be non-empty with no whitespace or ":"');
  }

  const body = await readCsv(io.stdin);
  if (body.length === 0) throw new Refusal('the file is empty');
  const coordinator = await activeCoordinator(coordinatorRef, io);
  if (!coordinator.signalstackOrgId) {
    throw new Refusal(`coordinator ${coordinator.id} has no Signals org; every row would fail`);
  }
  await requireValidHeader(type, body, io);
  const subject = await keycloakSubject(coordinator.id, io);
  const log = logger.child({
    operation: 'tools.bulkUpload',
    coordinator_id: coordinator.id,
    operator,
  });

  const skipRateLimit = values['skip-rate-limit'] === true;
  if (skipRateLimit) {
    log.warn({ status: 'skipped', sub_operation: 'rateLimit' }, 'rate limit skipped by operator');
  } else {
    const rate = await withTimeout(checkBulkUploadRate(subject), io.callTimeoutMs, 'rate limit');
    if (!rate.allowed) throw new Refusal(`rate limited; retry in ${rate.retryAfterSeconds}s`);
  }

  const { upload: reserved, ref } = await withTimeout(
    reserveBulkUpload({
      aggregatorId: coordinator.id,
      uploadedBy: subject,
      serves: coordinator.serves,
      participantType: type,
      log,
    }),
    io.callTimeoutMs,
    'upload create',
  );
  const uploadId = reserved.id;
  io.out(`upload ${uploadId} created`);
  const runLog = log.child({ upload_id: uploadId });
  try {
    const put = await withTimeout(
      getObjectStorage().put({ ref, body, contentType: 'text/csv' }),
      io.callTimeoutMs,
      'storage write',
    );
    if (!put.success) throw put.error;
    await withTimeout(saveStorageKey(uploadId, ref.key), io.callTimeoutMs, 'storage key save');
    await withTimeout(
      startBulkUpload({ uploadId, aggregatorId: coordinator.id, attestation: true, log: runLog }),
      io.callTimeoutMs,
      'upload start',
    );
  } catch (err) {
    runLog.error({ status: 'failure', error: errorMessage(err) });
    await discardIfNotStarted(uploadId, coordinator.id, ref, runLog, io);
    throw err;
  }
  runLog.info({ status: 'success', skip_rate_limit: skipRateLimit });
  io.out(`upload ${uploadId} started`);

  const done = await waitForResult(uploadId, coordinator.id, io);
  if (!done) {
    io.out(`upload ${uploadId} is still processing; check later with --upload-id ${uploadId}`);
    return 1;
  }
  return report(done, io);
}

/**
 * Runs the command and returns its exit code.
 *
 * @throws {Refusal} When a precondition refuses.
 * @throws {UsageError} When the flags are wrong.
 */
async function main(args: string[], io: CommandIo): Promise<number> {
  const values = parseFlags(args);
  const coordinatorRef = values.coordinator;
  if (!coordinatorRef) throw new UsageError('--coordinator is required');
  const uploadId = values['upload-id'];
  if (uploadId === undefined) {
    if (values['errors-csv'] === true) throw new UsageError('--errors-csv needs --upload-id');
    return upload(values, coordinatorRef, io);
  }
  if (!UUID_RE.test(uploadId)) throw new UsageError('--upload-id must be a UUID');
  const extra: string[] = [];
  if (values.type !== undefined) extra.push('--type');
  if (values.file !== undefined) extra.push('--file');
  if (values.operator !== undefined) extra.push('--operator');
  if (values['skip-rate-limit'] === true) extra.push('--skip-rate-limit');
  if (extra.length > 0) {
    throw new UsageError(`--upload-id cannot be combined with ${extra.join(', ')}`);
  }
  return followUp(coordinatorRef, uploadId, values['errors-csv'] === true, io);
}

/** Runs the command and maps the outcome to an exit code. Exported for tests. */
export async function run(args: string[], io: CommandIo): Promise<number> {
  try {
    return await main(args, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.out(err.message);
      io.out(USAGE);
      return 2;
    }
    if (err instanceof Refusal) {
      io.out(`REFUSED: ${err.message}`);
    } else if (err instanceof HttpError) {
      io.out(`REFUSED: ${err.code}: ${err.detail}`);
    } else {
      logger.error({ operation: 'tools.bulkUpload', status: 'failure', error: errorMessage(err) });
      io.out(`FAILED: ${errorMessage(err)}`);
    }
    return 1;
  }
}

/** Whether this module is the process entry, including through a symlink. */
function isEntry(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    existsSync(entry) &&
    pathToFileURL(realpathSync(entry)).href === import.meta.url
  );
}

/** Closes every connection the command opened so the process can exit. */
async function closeAll(): Promise<void> {
  const [{ closeDb }, { closeRedis }, { closeBulkQueue }, { closeRateLimiter }] = await Promise.all(
    [
      import('../db/client.js'),
      import('../services/redis/index.js'),
      import('../services/bulk-queue/index.js'),
      import('../services/rate-limiter/index.js'),
    ],
  );
  await Promise.allSettled([closeDb(), closeRedis(), closeBulkQueue(), closeRateLimiter()]);
}

if (isEntry()) {
  initObjectStorage(config);
  const code = await run(process.argv.slice(2), {
    out: (line) => process.stderr.write(`${line}\n`),
    csvOut: process.stdout,
    stdin: process.stdin,
    pollIntervalMs: POLL_INTERVAL_MS,
    pollTimeoutMs: config.BULK_UPLOAD_CMD_WAIT_MS,
    callTimeoutMs: config.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  await withTimeout(closeAll(), config.BULK_UPLOAD_CMD_CALL_TIMEOUT_MS, 'shutdown').catch(
    (err: unknown) => {
      logger.warn({ operation: 'tools.bulkUpload', status: 'failure', error: errorMessage(err) });
    },
  );
  // A call that timed out may still hold a connection open.
  process.exit(code);
}
