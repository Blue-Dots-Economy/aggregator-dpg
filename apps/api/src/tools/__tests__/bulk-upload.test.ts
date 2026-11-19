import { tmpdir } from 'node:os';
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
  BulkUploadsStoreFake,
  type BulkUpload,
  type BulkUploadStatus,
  type CreateBulkUploadInput,
  type StoreResult,
} from '../../services/bulk-uploads-store/index.js';
import { _setBulkFileEnqueuer } from '../../services/bulk-queue/index.js';
import { _setCountsLoader, type UploadCounts } from '../../services/bulk-upload/counts.js';
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

const { loadConsentConfigMock } = vi.hoisted(() => ({ loadConsentConfigMock: vi.fn() }));

// The consent config loader reads files and has no fake.
vi.mock('@aggregator-dpg/config-loader/fs', () => ({ loadConsentConfig: loadConsentConfigMock }));

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

/** The store fake with a fixed upload id and statuses that advance on each read. */
class StoreFake extends BulkUploadsStoreFake {
  /** Statuses `findById` steps through once the upload has left `pending`. */
  progress: BulkUploadStatus[] = [];

  override async create(input: CreateBulkUploadInput): Promise<StoreResult<BulkUpload>> {
    const created = await super.create(input);
    if (!created.ok) return created;
    this.rows.delete(created.value.id);
    const row: BulkUpload = { ...created.value, id: UPLOAD_1 };
    this.rows.set(row.id, row);
    return { ok: true, value: row };
  }

  override async findById(
    id: string,
    aggregatorId: string,
  ): Promise<StoreResult<BulkUpload | null>> {
    const found = await super.findById(id, aggregatorId);
    if (!found.ok || !found.value || found.value.status === 'pending') return found;
    const next = this.progress.shift();
    if (!next) return found;
    const row: BulkUpload = { ...found.value, status: next };
    this.rows.set(id, row);
    return { ok: true, value: row };
  }
}

/** A stdin stream carrying `text`. */
const stdinOf = (text: string | Buffer): Readable =>
  Readable.from([Buffer.isBuffer(text) ? text : Buffer.from(text)]);

describe('bulk-upload command', () => {
  let csv: string;

  let store: StoreFake;
  let storage: FakeObjectStorage;
  let ledger: ConsentLedgerFake;
  let enqueueMock: ReturnType<typeof vi.fn<(payload: { uploadId: string }) => Promise<void>>>;
  let counts: UploadCounts;
  let rateChecker: ReturnType<typeof vi.fn<(key: string) => Promise<BulkUploadRateResult>>>;
  let lines: string[];
  let csvOut: PassThrough;
  let csvChunks: Buffer[];

  const io = (stdin: Readable = stdinOf(csv), over: Partial<CommandIo> = {}): CommandIo => ({
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
    const v = { coordinator: COORD, type: 'seeker', file: '-', operator: 'ops-team', ...over };
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
    lines = [];
    csvChunks = [];
    csvOut = new PassThrough();
    csvOut.on('data', (c: Buffer) => csvChunks.push(c));
    counts = { totalRows: 2, passed: 1, failed: 1, skipped: 0 };
    _setCountsLoader(async () => counts);

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
    enqueueMock = vi.fn(async ({ uploadId }: { uploadId: string }) => {
      const row = store.get(uploadId);
      if (!row) return;
      const errorsKey = row.storageKey.replace('raw.csv', 'errors.csv');
      storage.seed({ area: 'bulk-uploads', key: errorsKey }, Buffer.from(ERRORS_CSV));
      store.seed([{ ...row, status: 'completed', errorsCsvStorageKey: errorsKey }]);
    });
    _setBulkFileEnqueuer(enqueueMock);
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
    _setBulkFileEnqueuer(null);
    _setCountsLoader(null);
    _setBulkUploadRateChecker(null);
    _setSchemaLoader(null);
  });

  describe('a new upload', () => {
    it('uploads as the coordinator with the portal attestation and points to the errors report', async () => {
      expect(await run(args(), io())).toBe(0);

      const upload = store.get(UPLOAD_1);
      expect(upload?.uploadedBy).toBe(SUBJECT);
      expect(upload?.aggregatorId).toBe(COORD);
      expect(storage.read(rawRef)?.toString()).toBe(csv);
      expect(rateChecker).toHaveBeenCalledWith(SUBJECT);
      const [record] = ledger.list();
      expect(record?.subjectId).toBe(COORD);
      expect(record?.source).toBe(`bulk_upload:${UPLOAD_1}:v2`);
      expect(lines).toEqual([
        `upload ${UPLOAD_1} created`,
        `upload ${UPLOAD_1} started`,
        'status: completed',
        'rows: 2 total, 1 passed, 1 failed, 0 skipped',
        `errors report: --upload-id ${UPLOAD_1} --errors-csv > errors.csv`,
      ]);
    });

    it('finds the coordinator by email', async () => {
      const code = await run(args({ coordinator: 'coord@example.org' }), io());
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
      expect(store.get(UPLOAD_1)).toBeUndefined();

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
      expect(store.get(UPLOAD_1)).toBeUndefined();
    });

    it('refuses a header the worker would reject', async () => {
      const [header = '', row = ''] = csv.split('\n');
      const [, ...rest] = header.split(',');
      const [, ...restCells] = row.split(',');
      expect(await run(args(), io(stdinOf(`${rest.join(',')}\n${restCells.join(',')}\n`)))).toBe(1);
      expect(lines[0]).toMatch(/^REFUSED: missing columns: /);

      lines = [];
      expect(await run(args(), io(stdinOf(`${header},shoe_size\n${row},9\n`)))).toBe(1);
      expect(lines).toEqual(['REFUSED: unknown columns: shoe_size']);
      expect(store.get(UPLOAD_1)).toBeUndefined();
    });

    it.each([
      ['a ";" delimiter', 'name;phone;age\nAsha;9000000001;24\n', /^REFUSED: missing columns: /],
      [
        'invalid UTF-8',
        Buffer.concat([
          Buffer.from('name,phone,age\nAsha,'),
          Buffer.from([0xc3, 0x28]),
          Buffer.from(',24\n'),
        ]),
        /^REFUSED: the file is not valid UTF-8$/,
      ],
    ])('refuses %s, as the worker does', async (_name, body, message) => {
      expect(await run(args(), io(stdinOf(body)))).toBe(1);
      expect(lines).toEqual([expect.stringMatching(message)]);
      expect(store.get(UPLOAD_1)).toBeUndefined();
    });

    it.each([
      ['header cells with spaces around them', ' name , phone ,age\nAsha,9000000001,24\n'],
      ['blank lines before the header', '\n \n\r\nname,phone,age\nAsha,9000000001,24\n'],
      ['a byte-order mark', '﻿name,phone,age\nAsha,9000000001,24\n'],
    ])('accepts %s, as the worker does', async (_name, body) => {
      expect(await run(args(), io(stdinOf(body)))).toBe(0);
    });

    it('refuses an empty or oversized file', async () => {
      expect(await run(args(), io(Readable.from([])))).toBe(1);
      const big = Buffer.alloc(config.BULK_UPLOAD_MAX_BYTES + 1, 'a');
      expect(await run(args(), io(stdinOf(big)))).toBe(1);
      expect(lines).toEqual([
        'REFUSED: the file is empty',
        `REFUSED: the file is larger than ${config.BULK_UPLOAD_MAX_BYTES} bytes`,
      ]);
      expect(store.get(UPLOAD_1)).toBeUndefined();
    });
  });

  describe('failures after the upload is created', () => {
    it('reports the upload id when the storage write fails', async () => {
      storage.failNext('put', new UpstreamError('storage down'));
      expect(await run(args(), io())).toBe(1);
      expect(lines).toEqual([`upload ${UPLOAD_1} created`, 'FAILED: storage down']);
      expect(store.get(UPLOAD_1)?.status).toBe('pending');
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
      expect(store.get(UPLOAD_1)?.status).toBe('uploaded');
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
      const row = store.get(UPLOAD_1);
      if (row) {
        store.seed([{ ...row, status: 'file_failed', statusReason: 'header_mismatch' }]);
      }
      lines = [];
      expect(await run(['--coordinator', COORD, '--upload-id', UPLOAD_1], io())).toBe(1);
      expect(lines).toEqual(['status: file_failed (header_mismatch)']);
    });

    it('refuses the errors report of an upload that has none', async () => {
      enqueueMock.mockImplementation(async ({ uploadId }: { uploadId: string }) => {
        const row = store.get(uploadId);
        if (row) store.seed([{ ...row, status: 'completed' }]);
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

    it.each(['seekers.csv', '/etc/passwd', './-'])('answers 2 for --file %j', async (file) => {
      expect(await run(args({ file }), io())).toBe(2);
      expect(lines[0]).toBe('--file must be - (the CSV is read from stdin)');
      expect(store.get(UPLOAD_1)).toBeUndefined();
    });

    it.each(['ops:team', 'ops team'])('answers 2 for operator %j', async (operator) => {
      expect(await run(args({ operator }), io())).toBe(2);
    });
  });
});
