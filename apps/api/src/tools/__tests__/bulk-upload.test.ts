import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setObjectStorage } from '@aggregator-dpg/object-storage';
import { FakeObjectStorage } from '@aggregator-dpg/object-storage/testing';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { NetworkSchemaLoader } from '@aggregator-dpg/schema-loader/network';
import {
  SchemaNotFoundError,
  type JsonSchema,
  type SchemaRef,
} from '@aggregator-dpg/schema-loader/interface';
import type { ObjectRef } from '@aggregator-dpg/object-storage/interface';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import { run, type CommandIo } from '../bulk-upload.js';
import { config } from '../../config.js';
import {
  _setBulkUploadsStore,
  BulkUploadsStoreBase,
  type BulkUpload,
  type CreateBulkUploadInput,
  type StoreResult,
} from '../../services/bulk-uploads-store/index.js';
import type {
  BulkUploadStatus,
  ListBulkUploadsResult,
} from '../../services/bulk-uploads-store/interface.js';
import {
  _setBulkUploadRateChecker,
  type BulkUploadRateResult,
} from '../../services/bulk-upload-rate.js';
import { _setConsentLedger } from '../../services/consent-ledger/index.js';
import { _setIdentityStore, InMemoryIdentityStore } from '../../services/identity-store/index.js';
import { IDP_PROVIDER } from '../../services/idp-admin/provider.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { _setSchemaLoader } from '../../services/schema-loader/index.js';
import { _setUserStore, buildCoordinator, UserStoreFake } from '../../services/user-store/index.js';

const { enqueueMock, loadConsentConfigMock, onboardingRows, keyUpdates } = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  loadConsentConfigMock: vi.fn(),
  onboardingRows: [] as Array<Record<string, unknown>>,
  keyUpdates: [] as string[],
}));

vi.mock('../../services/bulk-queue/index.js', () => ({ enqueueBulkFileProcess: enqueueMock }));
vi.mock('@aggregator-dpg/config-loader/fs', () => ({ loadConsentConfig: loadConsentConfigMock }));
vi.mock('../../db/client.js', () => ({
  getDb: () => ({
    update: () => ({
      set: (vals: { storageKey: string }) => ({
        where: () => {
          keyUpdates.push(vals.storageKey);
          return Promise.resolve();
        },
      }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(onboardingRows) }) }),
    }),
  }),
}));

const COORD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PENDING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NO_LOGIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NO_ORG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UPLOAD_1 = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'kc-subject-1';
const ERRORS_CSV =
  'name,phone,error_category,error_reason,what_to_do\nChaitra,9000000001,validation,"languageSpoken.0: must be one of: Kannada, Hindi",Check the values\n';

/** A participant schema with two required columns and one optional one. */
const PARTICIPANT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name', 'phone'],
  properties: { name: { type: 'string' }, phone: { type: 'string' }, age: { type: 'integer' } },
};

/** Serves {@link PARTICIPANT_SCHEMA} for seeker and provider; the fixture network's schemas are empty. */
class SchemaLoaderFake extends NetworkSchemaLoader {
  constructor() {
    super({ rootDir: tmpdir(), getNetworkConfig: () => Promise.resolve(buildBlueDotConfig()) });
  }

  override async getSchema(ref: SchemaRef): Promise<Result<JsonSchema, BaseError>> {
    return ref.id === 'participant-seeker' || ref.id === 'participant-provider'
      ? ok(PARTICIPANT_SCHEMA)
      : err(new SchemaNotFoundError(ref));
  }
}

/** Bulk-uploads store fake; the real storage key arrives through the mocked DB update. */
class StoreFake extends BulkUploadsStoreBase {
  rows = new Map<string, BulkUpload>();
  /** Statuses `findById` steps through once the upload has left `pending`. */
  progress: BulkUploadStatus[] = [];

  async create(input: CreateBulkUploadInput): Promise<StoreResult<BulkUpload>> {
    const now = new Date('2026-11-19T00:00:00Z');
    const row: BulkUpload = {
      ...input,
      id: UPLOAD_1,
      contentFingerprint: null,
      status: 'pending',
      statusReason: null,
      errorsCsvStorageKey: null,
      lastProgressAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.rows.set(row.id, row);
    return { ok: true, value: row };
  }

  async findById(id: string, aggregatorId: string): Promise<StoreResult<BulkUpload | null>> {
    const row = this.rows.get(id);
    if (!row || row.aggregatorId !== aggregatorId) return { ok: true, value: null };
    const key =
      row.storageKey === 'pending' ? (keyUpdates.at(-1) ?? row.storageKey) : row.storageKey;
    const next = row.status !== 'pending' ? this.progress.shift() : undefined;
    const current: BulkUpload = { ...row, storageKey: key, status: next ?? row.status };
    this.rows.set(id, current);
    return { ok: true, value: current };
  }

  async list(): Promise<StoreResult<ListBulkUploadsResult>> {
    return { ok: true, value: { rows: [...this.rows.values()], total: this.rows.size } };
  }

  async markUploaded(id: string, _agg: string, fp: string): Promise<StoreResult<BulkUpload>> {
    const row = this.rows.get(id);
    if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
    const updated: BulkUpload = { ...row, status: 'uploaded', contentFingerprint: fp };
    this.rows.set(id, updated);
    return { ok: true, value: updated };
  }

  async deletePending(): Promise<StoreResult<void>> {
    return { ok: true, value: undefined };
  }
}

describe('bulk-upload command', () => {
  let dir: string;
  let csvPath: string;
  let csv: string;

  let store: StoreFake;
  let storage: FakeObjectStorage;
  let ledger: ConsentLedgerFake;
  let rateChecker: ReturnType<typeof vi.fn<(key: string) => Promise<BulkUploadRateResult>>>;
  let lines: string[];
  let csvOut: PassThrough;
  let csvChunks: Buffer[];

  const io = (stdin: Readable = Readable.from([]), over: Partial<CommandIo> = {}): CommandIo => ({
    out: (l) => lines.push(l),
    csvOut,
    stdin,
    pollIntervalMs: 0,
    pollTimeoutMs: 1_000,
    callTimeoutMs: 1_000,
    sleep: () => Promise.resolve(),
    ...over,
  });
  const args = (over: Record<string, string> = {}, extra: string[] = []) => {
    const v = { coordinator: COORD, type: 'seeker', file: csvPath, operator: 'ops-team', ...over };
    return [
      '--coordinator',
      v.coordinator,
      '--type',
      v.type,
      '--file',
      v.file,
      '--operator',
      v.operator,
      ...extra,
    ];
  };
  const rawRef: ObjectRef = {
    area: 'bulk-uploads',
    key: `bulk-uploads/${COORD}/${UPLOAD_1}/raw.csv`,
  };

  beforeEach(async () => {
    _setNetworkConfig(buildBlueDotConfig());
    _setSchemaLoader(new SchemaLoaderFake());
    csv = 'name,phone,age\nAsha,9000000001,24\n';

    dir = await mkdtemp(path.join(tmpdir(), 'bulk-upload-cmd-'));
    csvPath = path.join(dir, 'seekers.csv');
    await writeFile(csvPath, csv);
    lines = [];
    csvChunks = [];
    csvOut = new PassThrough();
    csvOut.on('data', (c: Buffer) => csvChunks.push(c));
    keyUpdates.length = 0;
    onboardingRows.length = 0;
    onboardingRows.push({ total: 2, passed: 1, failed: 1, skipped: 0 });

    loadConsentConfigMock.mockReset().mockResolvedValue({
      audiences: {
        aggregator: {
          documents: {
            terms: { current_version: 1 },
            privacy: { current_version: 1 },
            bulk_upload_attestation: { current_version: 2 },
          },
        },
      },
    });
    storage = new FakeObjectStorage();
    _setObjectStorage(storage);
    store = new StoreFake();
    _setBulkUploadsStore(store);
    // Stands in for the worker: completes the upload with one failed row.
    enqueueMock.mockReset().mockImplementation(async ({ uploadId }: { uploadId: string }) => {
      const row = store.rows.get(uploadId);
      if (!row) return;
      const errorsKey = row.storageKey.replace('raw.csv', 'errors.csv');
      storage.seed({ area: 'bulk-uploads', key: errorsKey }, Buffer.from(ERRORS_CSV));
      store.rows.set(uploadId, { ...row, status: 'completed', errorsCsvStorageKey: errorsKey });
    });
    ledger = new ConsentLedgerFake();
    _setConsentLedger(ledger);

    const users = new UserStoreFake();
    users.seed([
      buildCoordinator({
        id: COORD,
        serves: ['seeker'],
        status: 'active',
        signalstackOrgId: 'sig-1',
        contactEmail: 'coord@example.org',
      }),
      buildCoordinator({ id: PENDING, orgSlug: 'p', serves: ['seeker'], status: 'pending' }),
      buildCoordinator({
        id: NO_LOGIN,
        orgSlug: 'n',
        serves: ['seeker'],
        status: 'active',
        signalstackOrgId: 'sig-2',
      }),
      buildCoordinator({ id: NO_ORG, orgSlug: 'o', serves: ['seeker'], status: 'active' }),
    ]);
    _setUserStore(users);
    const identities = new InMemoryIdentityStore();
    await identities.link(COORD, IDP_PROVIDER, SUBJECT);
    await identities.link(NO_ORG, IDP_PROVIDER, 'kc-subject-2');
    _setIdentityStore(identities);
    rateChecker = vi
      .fn<(key: string) => Promise<BulkUploadRateResult>>()
      .mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    _setBulkUploadRateChecker(rateChecker);
  });

  afterEach(async () => {
    _setBulkUploadRateChecker(null);
    _setSchemaLoader(null);
    await rm(dir, { recursive: true, force: true });
  });

  describe('a new upload', () => {
    it('uploads as the coordinator with the portal attestation and prints why rows failed', async () => {
      expect(await run(args(), io())).toBe(0);

      const upload = store.rows.get(UPLOAD_1);
      expect(upload?.uploadedBy).toBe(SUBJECT);
      expect(upload?.aggregatorId).toBe(COORD);
      expect(storage.read(rawRef)?.toString()).toBe(csv);
      expect(rateChecker).toHaveBeenCalledWith(SUBJECT);
      const [record] = ledger.list();
      expect(record?.subjectId).toBe(COORD);
      expect(record?.source).toBe(`bulk_upload:${UPLOAD_1}:v2`);
      expect(lines.slice(0, 5)).toEqual([
        `upload ${UPLOAD_1} created`,
        `upload ${UPLOAD_1} started`,
        'status: completed',
        'rows: 2 total, 1 passed, 1 failed, 0 skipped',
        'failed rows:',
      ]);
      expect(lines[5]).toMatch(/^ {2}name\s+category\s+reason\s+what to do$/);
      expect(lines[6]).toMatch(
        /Chaitra\s+validation\s+languageSpoken\.0: must be one of: Kannada, Hindi\s+Check the values/,
      );
      expect(lines.at(-1)).toBe(
        `errors report (all columns): --upload-id ${UPLOAD_1} --errors-csv`,
      );
    });

    it('reads the CSV from stdin and finds the coordinator by email', async () => {
      const code = await run(
        args({ coordinator: 'coord@example.org', file: '-' }),
        io(Readable.from([Buffer.from(csv)])),
      );
      expect(code).toBe(0);
      expect(storage.read(rawRef)?.toString()).toBe(csv);
    });

    it('prints each status while it waits', async () => {
      enqueueMock.mockResolvedValue(undefined);
      store.progress = ['file_validating', 'row_processing', 'row_processing', 'completed'];
      expect(await run(args(), io())).toBe(0);
      expect(lines).toEqual(
        expect.arrayContaining(['  file_validating…', '  row_processing…', 'status: completed']),
      );
      expect(lines.filter((l) => l === '  row_processing…')).toHaveLength(1);
    });

    it('reports a run still processing when the wait runs out', async () => {
      enqueueMock.mockResolvedValue(undefined);
      expect(await run(args(), io(undefined, { pollTimeoutMs: 0 }))).toBe(1);
      expect(lines.at(-1)).toBe(
        `upload ${UPLOAD_1} is still processing; check later with --upload-id ${UPLOAD_1}`,
      );
    });

    it('refuses when rate limited, and --skip-rate-limit skips the limit', async () => {
      rateChecker.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
      expect(await run(args(), io())).toBe(1);
      expect(lines).toEqual(['REFUSED: rate limited; retry in 60s']);
      expect(store.rows.size).toBe(0);

      expect(await run(args({}, ['--skip-rate-limit']), io())).toBe(0);
      expect(rateChecker).toHaveBeenCalledTimes(1);
    });
  });

  describe('refusals before anything is written', () => {
    it.each([
      ['an unknown coordinator', { coordinator: 'x@example.org' }, /no coordinator/],
      ['an inactive coordinator', { coordinator: PENDING }, /is pending, not active/],
      [
        'a coordinator with no recorded login',
        { coordinator: NO_LOGIN },
        /no recorded Keycloak login/,
      ],
      ['a coordinator with no Signals org', { coordinator: NO_ORG }, /no Signals org/],
      ['a type the coordinator does not serve', { type: 'provider' }, /./],
      ['an unknown type', { type: 'farmer' }, /participant schema unavailable/],
    ])('refuses %s', async (_name, over, message) => {
      expect(await run(args(over), io())).toBe(1);
      expect(lines.join('\n')).toMatch(message);
      expect(store.rows.size).toBe(0);
    });

    it('refuses a header the worker would reject', async () => {
      const [header = '', row = ''] = csv.split('\n');
      const [, ...rest] = header.split(',');
      const [, ...restCells] = row.split(',');
      await writeFile(csvPath, `${rest.join(',')}\n${restCells.join(',')}\n`);
      expect(await run(args(), io())).toBe(1);
      expect(lines[0]).toMatch(/^REFUSED: missing columns: /);

      await writeFile(csvPath, `${header},shoe_size\n${row},9\n`);
      lines = [];
      expect(await run(args(), io())).toBe(1);
      expect(lines).toEqual(['REFUSED: unknown columns: shoe_size']);
      expect(store.rows.size).toBe(0);
    });

    it('refuses an empty, unreadable or oversized file', async () => {
      await writeFile(csvPath, '');
      expect(await run(args(), io())).toBe(1);
      expect(await run(args({ file: path.join(dir, 'missing.csv') }), io())).toBe(1);
      const big = Buffer.alloc(config.BULK_UPLOAD_MAX_BYTES + 1, 'a');
      await writeFile(csvPath, big);
      expect(await run(args(), io())).toBe(1);
      expect(await run(args({ file: '-' }), io(Readable.from([big])))).toBe(1);
      expect(lines).toEqual([
        'REFUSED: the file is empty',
        expect.stringMatching(/^REFUSED: cannot read /),
        `REFUSED: the file is ${big.length} bytes; max ${config.BULK_UPLOAD_MAX_BYTES}`,
        `REFUSED: the file is larger than ${config.BULK_UPLOAD_MAX_BYTES} bytes`,
      ]);
      expect(store.rows.size).toBe(0);
    });
  });

  describe('failures after the upload is created', () => {
    it('reports the upload id when the storage write fails', async () => {
      storage.failNext('put', new UpstreamError('storage down'));
      expect(await run(args(), io())).toBe(1);
      expect(lines).toEqual([`upload ${UPLOAD_1} created`, 'FAILED: storage down']);
      expect(store.rows.get(UPLOAD_1)?.status).toBe('pending');
    });

    it('fails closed and deletes the stored CSV when the attestation cannot be recorded', async () => {
      vi.spyOn(ledger, 'recordRegistrationConsent').mockResolvedValue(
        err(new UpstreamError('ledger down')),
      );
      expect(await run(args(), io())).toBe(1);
      expect(lines.at(-1)).toMatch(/^REFUSED: CONSENT_WRITE_FAILED: /);
      expect(storage.read(rawRef)).toBeUndefined();
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('keeps the CSV for the watchdog when queueing fails after the upload was marked', async () => {
      enqueueMock.mockRejectedValue(new Error('redis down'));
      expect(await run(args(), io())).toBe(1);
      expect(lines.at(-1)).toMatch(/^REFUSED: INTERNAL: /);
      expect(store.rows.get(UPLOAD_1)?.status).toBe('uploaded');
      expect(storage.read(rawRef)?.toString()).toBe(csv);
    });

    it('stops a call that hangs', async () => {
      vi.spyOn(storage, 'put').mockReturnValue(new Promise(() => undefined));
      expect(await run(args(), io(undefined, { callTimeoutMs: 5 }))).toBe(1);
      expect(lines.at(-1)).toBe('FAILED: storage write timed out after 5 ms');
    });
  });

  describe('--upload-id', () => {
    it('writes only the errors report to csvOut', async () => {
      await run(args(), io());
      lines = [];
      const code = await run(
        ['--coordinator', COORD, '--upload-id', UPLOAD_1, '--errors-csv'],
        io(),
      );
      expect(code).toBe(0);
      expect(Buffer.concat(csvChunks).toString()).toBe(ERRORS_CSV);
      expect(lines).toEqual([]);
    });

    it('reports an earlier upload', async () => {
      enqueueMock.mockResolvedValue(undefined);
      await run(args(), io(undefined, { pollTimeoutMs: 0 }));
      const row = store.rows.get(UPLOAD_1);
      if (row) {
        store.rows.set(UPLOAD_1, {
          ...row,
          status: 'file_failed',
          statusReason: 'header_mismatch',
        });
      }
      lines = [];
      expect(await run(['--coordinator', COORD, '--upload-id', UPLOAD_1], io())).toBe(1);
      expect(lines).toEqual(['status: file_failed (header_mismatch)']);
    });

    it('refuses the errors report of an upload that has none', async () => {
      enqueueMock.mockImplementation(async ({ uploadId }: { uploadId: string }) => {
        const row = store.rows.get(uploadId);
        if (row) store.rows.set(uploadId, { ...row, status: 'completed' });
      });
      await run(args(), io());
      lines = [];
      const code = await run(
        ['--coordinator', COORD, '--upload-id', UPLOAD_1, '--errors-csv'],
        io(),
      );
      expect(code).toBe(1);
      expect(lines).toEqual(['REFUSED: no errors report: every row passed']);
    });
  });

  describe('usage', () => {
    it.each([
      [[], '--coordinator is required'],
      [['--coordinator', COORD, '--type', 'seeker'], '--type, --file and --operator are required'],
      [['--bogus'], "Unknown option '--bogus'"],
      [['--coordinator', COORD, '--upload-id', 'nope'], '--upload-id must be a UUID'],
      [['--coordinator', COORD, '--errors-csv'], '--errors-csv needs --upload-id'],
      [
        ['--coordinator', COORD, '--upload-id', UPLOAD_1, '--type', 'seeker', '--skip-rate-limit'],
        '--upload-id cannot be combined with --type, --skip-rate-limit',
      ],
    ])('answers 2 for %j', async (argv, message) => {
      expect(await run(argv, io())).toBe(2);
      expect(lines[0]).toContain(message);
      expect(lines[1]).toMatch(/^usage: /);
    });

    it.each(['ops:team', 'ops team'])('answers 2 for operator %j', async (operator) => {
      expect(await run(args({ operator }), io())).toBe(2);
    });
  });
});
