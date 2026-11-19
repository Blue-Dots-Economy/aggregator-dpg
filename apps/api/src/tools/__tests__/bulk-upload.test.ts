import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setObjectStorage } from '@aggregator-dpg/object-storage';
import { FakeObjectStorage } from '@aggregator-dpg/object-storage/testing';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { _main, _Refusal, type CommandIo } from '../bulk-upload.js';
import {
  _setBulkUploadsStore,
  BulkUploadsStoreBase,
  type BulkUpload,
  type CreateBulkUploadInput,
  type StoreResult,
} from '../../services/bulk-uploads-store/index.js';
import type { ListBulkUploadsResult } from '../../services/bulk-uploads-store/interface.js';
import {
  _setBulkUploadRateChecker,
  type BulkUploadRateResult,
} from '../../services/bulk-upload-rate.js';
import { _setConsentLedger } from '../../services/consent-ledger/index.js';
import { _setIdentityStore, InMemoryIdentityStore } from '../../services/identity-store/index.js';
import { IDP_PROVIDER } from '../../services/idp-admin/provider.js';
import { _setNetworkConfig } from '../../services/network-config.js';
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
const SUBJECT = 'kc-subject-1';
const CSV = 'name,phone\nA,9000000000\n';

/** Bulk-uploads store fake; the real storage key arrives through the mocked DB update. */
class StoreFake extends BulkUploadsStoreBase {
  rows = new Map<string, BulkUpload>();

  async create(input: CreateBulkUploadInput): Promise<StoreResult<BulkUpload>> {
    const now = new Date('2026-11-19T00:00:00Z');
    const row: BulkUpload = {
      ...input,
      id: `upload-${this.rows.size + 1}`,
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
    return { ok: true, value: row && row.aggregatorId === aggregatorId ? row : null };
  }

  async list(): Promise<StoreResult<ListBulkUploadsResult>> {
    return { ok: true, value: { rows: [...this.rows.values()], total: this.rows.size } };
  }

  async markUploaded(id: string, _agg: string, fp: string): Promise<StoreResult<BulkUpload>> {
    const row = this.rows.get(id);
    if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
    const updated: BulkUpload = {
      ...row,
      storageKey: keyUpdates.at(-1) ?? row.storageKey,
      status: 'uploaded',
      contentFingerprint: fp,
    };
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
  let store: StoreFake;
  let storage: FakeObjectStorage;
  let ledger: ConsentLedgerFake;
  let rateChecker: ReturnType<typeof vi.fn<(key: string) => Promise<BulkUploadRateResult>>>;
  let lines: string[];
  let csvOut: PassThrough;

  const io = (stdin: Readable = Readable.from([])): CommandIo => ({
    out: (l) => lines.push(l),
    csvOut,
    stdin,
    pollIntervalMs: 0,
    pollTimeoutMs: 0,
    sleep: () => Promise.resolve(),
  });
  const run = (args: string[], stdin?: Readable) => _main(args, io(stdin));
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

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bulk-upload-cmd-'));
    csvPath = path.join(dir, 'seekers.csv');
    await writeFile(csvPath, CSV);
    lines = [];
    csvOut = new PassThrough();
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
      storage.seed({ area: 'bulk-uploads', key: errorsKey }, Buffer.from('row,reason\n2,bad\n'));
      store.rows.set(uploadId, { ...row, status: 'completed', errorsCsvStorageKey: errorsKey });
    });
    ledger = new ConsentLedgerFake();
    _setConsentLedger(ledger);
    _setNetworkConfig(buildBlueDotConfig());

    const users = new UserStoreFake();
    users.seed([
      buildCoordinator({
        id: COORD,
        serves: ['seeker'],
        status: 'active',
        contactEmail: 'coord@example.org',
      }),
      buildCoordinator({ id: PENDING, orgSlug: 'p', serves: ['seeker'], status: 'pending' }),
      buildCoordinator({ id: NO_LOGIN, orgSlug: 'n', serves: ['seeker'], status: 'active' }),
    ]);
    _setUserStore(users);
    const identities = new InMemoryIdentityStore();
    await identities.link(COORD, IDP_PROVIDER, SUBJECT);
    _setIdentityStore(identities);
    rateChecker = vi
      .fn<(key: string) => Promise<BulkUploadRateResult>>()
      .mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    _setBulkUploadRateChecker(rateChecker);
  });

  afterEach(async () => {
    _setBulkUploadRateChecker(null);
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads as the coordinator and names the operator in the attestation', async () => {
    expect(await run(args())).toBe(0);

    const upload = store.rows.get('upload-1');
    expect(upload?.uploadedBy).toBe(SUBJECT);
    expect(upload?.aggregatorId).toBe(COORD);
    expect(upload?.storageKey).toBe(`bulk-uploads/${COORD}/upload-1/raw.csv`);
    expect(storage.read({ area: 'bulk-uploads', key: upload?.storageKey ?? '' })?.toString()).toBe(
      CSV,
    );
    expect(rateChecker).toHaveBeenCalledWith(SUBJECT);
    const [record] = ledger.list();
    expect(record?.subjectId).toBe(COORD);
    expect(record?.source).toBe('bulk_upload:upload-1:v2:provisioned:ops-team');
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: 'upload-1',
        aggregatorId: COORD,
        participantType: 'seeker',
      }),
    );
    expect(lines).toEqual([
      'upload upload-1 started',
      'status: completed',
      'rows: 2 total, 1 passed, 1 failed, 0 skipped',
      'errors report: fetch with --upload-id upload-1 --errors-csv',
    ]);
  });

  it('reads the CSV from stdin and finds the coordinator by email', async () => {
    const code = await run(
      args({ coordinator: 'coord@example.org', file: '-' }),
      Readable.from([Buffer.from(CSV)]),
    );
    expect(code).toBe(0);
    const upload = store.rows.get('upload-1');
    expect(storage.read({ area: 'bulk-uploads', key: upload?.storageKey ?? '' })?.toString()).toBe(
      CSV,
    );
  });

  it('writes the errors report to csvOut', async () => {
    await run(args());
    const chunks: Buffer[] = [];
    csvOut.on('data', (c: Buffer) => chunks.push(c));
    expect(await run(['--coordinator', COORD, '--upload-id', 'upload-1', '--errors-csv'])).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('row,reason\n2,bad\n');
  });

  it('refuses when rate limited, and --skip-rate-limit skips the limit', async () => {
    rateChecker.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await expect(run(args())).rejects.toThrow(/rate limited/);
    expect(store.rows.size).toBe(0);

    expect(await run(args({}, ['--skip-rate-limit']))).toBe(0);
    expect(rateChecker).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown, inactive or never-approved coordinator before writing anything', async () => {
    await expect(run(args({ coordinator: 'x@example.org' }))).rejects.toThrow(_Refusal);
    await expect(run(args({ coordinator: PENDING }))).rejects.toThrow(/is pending, not active/);
    await expect(run(args({ coordinator: NO_LOGIN }))).rejects.toThrow(
      /no recorded Keycloak login/,
    );
    expect(store.rows.size).toBe(0);
  });

  it('refuses a profile type that is unknown or not served', async () => {
    await expect(run(args({ type: 'provider' }))).rejects.toThrow(/serves seeker, not provider/);
    await expect(run(args({ type: 'nope' }))).rejects.toThrow(/--type must be one of/);
    expect(store.rows.size).toBe(0);
  });

  it('refuses an empty or unreadable file before writing anything', async () => {
    await writeFile(csvPath, '');
    await expect(run(args())).rejects.toThrow(/empty/);
    await expect(run(args({ file: path.join(dir, 'missing.csv') }))).rejects.toThrow(/cannot read/);
    expect(store.rows.size).toBe(0);
  });

  it('fails closed when the attestation cannot be recorded', async () => {
    loadConsentConfigMock.mockResolvedValue({
      audiences: { aggregator: { documents: { terms: {}, privacy: {} } } },
    });
    await expect(run(args())).rejects.toThrow(/bulk_upload_attestation is not configured/);
    expect(store.rows.get('upload-1')?.status).toBe('pending');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('answers 2 for bad usage', async () => {
    expect(await run([])).toBe(2);
    expect(await run(['--coordinator', COORD, '--type', 'seeker'])).toBe(2);
    expect(await run(['--bogus'])).toBe(2);
    expect(await run(args({ operator: 'ops:team' }))).toBe(2);
    expect(await run(args({ operator: 'ops team' }))).toBe(2);
  });

  it('reports a run still processing, and --upload-id picks it up later', async () => {
    enqueueMock.mockResolvedValue(undefined);
    expect(await run(args())).toBe(1);
    expect(lines.at(-1)).toBe(
      'upload upload-1 is still processing; check later with --upload-id upload-1',
    );

    const row = store.rows.get('upload-1');
    if (row) {
      store.rows.set('upload-1', {
        ...row,
        status: 'file_failed',
        statusReason: 'header_mismatch',
      });
    }
    lines = [];
    expect(await run(['--coordinator', COORD, '--upload-id', 'upload-1'])).toBe(1);
    expect(lines).toEqual(['status: file_failed (header_mismatch)']);
  });
});
