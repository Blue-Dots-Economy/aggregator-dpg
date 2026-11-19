/**
 * Bulk-upload operator command (`@aggregator-dpg/api`). Runs a bulk upload on
 * a coordinator's behalf, without the coordinator signing in, through the same
 * store, storage layout, attestation and processing job as a portal upload.
 * Shipped in the API image and run in the API pod; runbook:
 * docs/bulk-upload-command-runbook.md.
 *
 *   node dist/tools/bulk-upload.js --coordinator <email or user id> --type <profile type> \
 *     --file <path.csv | -> --operator <name> [--skip-rate-limit]
 *   node dist/tools/bulk-upload.js --coordinator <email or user id> --upload-id <id> [--errors-csv]
 *
 * `--file -` reads the CSV from stdin. The second form waits for an upload and
 * prints its result, or with `--errors-csv` writes its errors report to stdout.
 * Output and logs carry ids, statuses and counts, never row data.
 * Exit codes: 0 ok, 1 refused or failed, 2 usage.
 */

import '../env.js';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { and, eq } from 'drizzle-orm';
import {
  buildKey,
  getObjectStorage,
  initObjectStorage,
  type ObjectRef,
} from '@aggregator-dpg/object-storage';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { errorMessage } from '@aggregator-dpg/shared-primitives/errors';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { bulkUploads, onboarding } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueueBulkFileProcess } from '../services/bulk-queue/index.js';
import { checkBulkUploadRate } from '../services/bulk-upload-rate.js';
import { getBulkUploadsStore } from '../services/bulk-uploads-store/index.js';
import type { BulkUpload, BulkUploadStatus } from '../services/bulk-uploads-store/interface.js';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import { getIdentityStore } from '../services/identity-store/index.js';
import { IDP_PROVIDER } from '../services/idp-admin/provider.js';
import { getNetworkConfig } from '../services/network-config.js';
import { provisionedBy } from '../services/provisioned.js';
import { getUserStore, type Coordinator } from '../services/user-store/index.js';
import { servedDomains } from '../services/user-store/serves.js';

const USAGE = [
  'usage: bulk-upload --coordinator <email or user id> --type <profile type> --file <path.csv | -> --operator <name> [--skip-rate-limit]',
  '       bulk-upload --coordinator <email or user id> --upload-id <id> [--errors-csv]',
].join('\n');

/** How often the upload status is read while waiting. */
const POLL_INTERVAL_MS = 5_000;

/** How long to wait for processing; a large file can take tens of minutes. */
const POLL_TIMEOUT_MS = 60 * 60 * 1000;

/** Only v1 of each participant schema exists, as for a portal upload. */
const SCHEMA_VERSION = 'v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TERMINAL: ReadonlySet<BulkUploadStatus> = new Set(['completed', 'failed', 'file_failed']);

/** A refusal. Printed as `REFUSED: …` with exit code 1. */
class Refusal extends Error {}

/** What the command reads from and writes to; tests replace them. */
export interface CommandIo {
  /** One line of human-readable output. */
  out: (line: string) => void;
  /** Where `--errors-csv` writes the report. */
  csvOut: Writable;
  stdin: Readable;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** Reads the CSV from a path, or from stdin for `-`, refusing more than the upload limit. */
async function readCsv(file: string, stdin: Readable): Promise<Buffer> {
  if (file !== '-') {
    return readFile(file).catch((e: unknown) => {
      throw new Refusal(`cannot read ${file}: ${errorMessage(e)}`);
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > config.BULK_UPLOAD_MAX_BYTES) {
      throw new Refusal(`the file is larger than ${config.BULK_UPLOAD_MAX_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Finds the coordinator by user id or email and requires it to be active. */
async function activeCoordinator(ref: string): Promise<Coordinator> {
  const store = getUserStore();
  const found = UUID_RE.test(ref) ? await store.findById(ref) : await store.findByContactEmail(ref);
  if (!found.ok) throw new Error(found.error.message);
  if (!found.value) throw new Refusal('no coordinator with that email or user id');
  if (found.value.status !== 'active') {
    throw new Refusal(`coordinator ${found.value.id} is ${found.value.status}, not active`);
  }
  return found.value;
}

/** The coordinator's Keycloak subject, which a portal upload stores as `uploaded_by`. */
async function keycloakSubject(coordinatorId: string): Promise<string> {
  const subject = await getIdentityStore().subjectOf(coordinatorId, IDP_PROVIDER);
  if (!subject.ok) throw new Error(subject.error.message);
  if (!subject.value) {
    throw new Refusal(`coordinator ${coordinatorId} has no recorded Keycloak login`);
  }
  return subject.value;
}

/** Refuses a profile type that is not a network domain or not served by the coordinator. */
async function requireServedType(coordinator: Coordinator, type: string): Promise<void> {
  const { domainIds } = await getNetworkConfig();
  if (!domainIds.includes(type)) {
    throw new Refusal(`--type must be one of: ${domainIds.join(', ')}`);
  }
  const served = servedDomains([...coordinator.serves], domainIds);
  if (!served.includes(type)) {
    throw new Refusal(`coordinator serves ${served.join(', ') || 'no profile type'}, not ${type}`);
  }
}

/**
 * Records the attestation as a portal upload does, naming the operator:
 * `bulk_upload:<uploadId>:v<n>:provisioned:<operator>`.
 */
async function recordAttestation(
  coordinatorId: string,
  uploadId: string,
  operator: string,
): Promise<void> {
  const { network, brand } = resolveActiveNetwork();
  const docs = (await loadConsentConfig(network, brand)).audiences.aggregator.documents;
  const attestation = docs.bulk_upload_attestation;
  if (!attestation) {
    throw new Refusal('bulk_upload_attestation is not configured for the aggregator audience');
  }
  const result = await getConsentLedger().recordRegistrationConsent({
    subjectType: 'user',
    subjectId: coordinatorId,
    network,
    brand: brand ?? null,
    termsVersion: docs.terms.current_version,
    privacyVersion: docs.privacy.current_version,
    source: `bulk_upload:${uploadId}:v${attestation.current_version}:${provisionedBy(operator)}`,
  });
  if (!result.success) throw result.error;
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
    const found = await getBulkUploadsStore().findById(uploadId, coordinatorId);
    if (!found.ok) throw new Error(found.error.message);
    if (!found.value) throw new Refusal(`upload ${uploadId} is not this coordinator's`);
    if (TERMINAL.has(found.value.status)) return found.value;
    if (found.value.status !== last) {
      last = found.value.status;
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
  const [row] = await getDb()
    .select({
      total: onboarding.total,
      passed: onboarding.passed,
      failed: onboarding.failed,
      skipped: onboarding.skipped,
    })
    .from(onboarding)
    .where(and(eq(onboarding.source, 'bulk'), eq(onboarding.batchId, upload.id)))
    .limit(1);
  if (row) {
    io.out(
      `rows: ${row.total ?? '?'} total, ${row.passed} passed, ${row.failed} failed, ${row.skipped} skipped`,
    );
  }
  if (upload.errorsCsvStorageKey) {
    io.out(`errors report: fetch with --upload-id ${upload.id} --errors-csv`);
  }
  return 0;
}

/** Writes the upload's errors report to `io.csvOut`. */
async function writeErrorsCsv(upload: BulkUpload, io: CommandIo): Promise<number> {
  if (upload.status !== 'completed') {
    throw new Refusal(`upload ${upload.id} is ${upload.status}; the report exists once completed`);
  }
  if (!upload.errorsCsvStorageKey) throw new Refusal('no errors report: every row passed');
  const stream = await getObjectStorage().openReadStream({
    area: 'bulk-uploads',
    key: upload.errorsCsvStorageKey,
  });
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
  const coordinator = await activeCoordinator(coordinatorRef);
  if (errorsCsv) {
    const found = await getBulkUploadsStore().findById(uploadId, coordinator.id);
    if (!found.ok) throw new Error(found.error.message);
    if (!found.value) throw new Refusal(`upload ${uploadId} is not this coordinator's`);
    return writeErrorsCsv(found.value, io);
  }
  const done = await waitForResult(uploadId, coordinator.id, io);
  if (!done) {
    io.out(`upload ${uploadId} is still processing`);
    return 1;
  }
  return report(done, io);
}

/**
 * Runs the command and returns its exit code. Exported for tests.
 *
 * @throws {Refusal} When a precondition refuses.
 */
async function main(args: string[], io: CommandIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
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
    }));
  } catch {
    io.out(USAGE);
    return 2;
  }
  const { coordinator: coordinatorRef, type, file, operator } = values;
  const uploadIdArg = values['upload-id'];
  if (!coordinatorRef) {
    io.out(USAGE);
    return 2;
  }
  if (uploadIdArg !== undefined) {
    return followUp(coordinatorRef, uploadIdArg, values['errors-csv'] === true, io);
  }
  if (!type || !file || !operator) {
    io.out(USAGE);
    return 2;
  }
  try {
    provisionedBy(operator);
  } catch {
    io.out('--operator must be non-empty with no whitespace or ":"');
    return 2;
  }

  const body = await readCsv(file, io.stdin);
  if (body.length === 0) throw new Refusal('the file is empty');
  if (body.length > config.BULK_UPLOAD_MAX_BYTES) {
    throw new Refusal(`the file is ${body.length} bytes; max ${config.BULK_UPLOAD_MAX_BYTES}`);
  }

  const coordinator = await activeCoordinator(coordinatorRef);
  await requireServedType(coordinator, type);
  const subject = await keycloakSubject(coordinator.id);
  const log = logger.child({
    operation: 'tools.bulkUpload',
    coordinator_id: coordinator.id,
    operator,
  });

  const skipRateLimit = values['skip-rate-limit'] === true;
  if (skipRateLimit) {
    log.warn({ status: 'skipped', sub_operation: 'rateLimit' }, 'rate limit skipped by operator');
  } else {
    const rate = await checkBulkUploadRate(subject);
    if (!rate.allowed) throw new Refusal(`rate limited; retry in ${rate.retryAfterSeconds}s`);
  }

  const store = getBulkUploadsStore();
  const created = await store.create({
    aggregatorId: coordinator.id,
    participantType: type,
    storageKey: 'pending',
    schemaId: `participant-${type}`,
    schemaVersion: SCHEMA_VERSION,
    uploadedBy: subject,
  });
  if (!created.ok) throw new Error(created.error.message);
  const uploadId = created.value.id;
  const ref: ObjectRef = {
    area: 'bulk-uploads',
    key: buildKey('bulk-uploads', coordinator.id, uploadId, 'raw.csv'),
  };

  const storage = getObjectStorage();
  const put = await storage.put({ ref, body, contentType: 'text/csv' });
  if (!put.success) throw put.error;
  await getDb()
    .update(bulkUploads)
    .set({ storageKey: ref.key, updatedAt: new Date() })
    .where(eq(bulkUploads.id, uploadId));
  const head = await storage.stat(ref);
  if (!head.success) throw head.error;
  if (!head.value) throw new Error('the stored CSV is missing');

  await recordAttestation(coordinator.id, uploadId, operator);
  const marked = await store.markUploaded(uploadId, coordinator.id, head.value.fingerprint);
  if (!marked.ok) throw new Error(marked.error.message);
  await enqueueBulkFileProcess({
    uploadId,
    aggregatorId: coordinator.id,
    s3Key: marked.value.storageKey,
    participantType: marked.value.participantType,
    schemaId: marked.value.schemaId,
    schemaVersion: marked.value.schemaVersion,
  });
  log.info({ status: 'success', upload_id: uploadId, skip_rate_limit: skipRateLimit });
  io.out(`upload ${uploadId} started`);

  const done = await waitForResult(uploadId, coordinator.id, io);
  if (!done) {
    io.out(`upload ${uploadId} is still processing; check later with --upload-id ${uploadId}`);
    return 1;
  }
  return report(done, io);
}

/** Whether this module is the process entry, including through a symlink. */
function isEntry(): boolean {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url;
  } catch {
    return false;
  }
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
  await closeDb();
  await Promise.allSettled([closeRedis(), closeBulkQueue(), closeRateLimiter()]);
}

if (isEntry()) {
  // Messages go to stderr so `--errors-csv` output on stdout stays a clean CSV.
  const out = (line: string) => process.stderr.write(`${line}\n`);
  initObjectStorage(config);
  try {
    process.exitCode = await main(process.argv.slice(2), {
      out,
      csvOut: process.stdout,
      stdin: process.stdin,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollTimeoutMs: POLL_TIMEOUT_MS,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } catch (err) {
    if (err instanceof Refusal) {
      out(`REFUSED: ${err.message}`);
    } else {
      logger.error({ operation: 'tools.bulkUpload', status: 'failure', error: errorMessage(err) });
      out(`FAILED: ${errorMessage(err)}`);
    }
    process.exitCode = 1;
  } finally {
    await closeAll();
  }
}

export { main as _main, Refusal as _Refusal };
