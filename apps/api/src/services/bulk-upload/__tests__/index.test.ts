/**
 * The shared create and start steps of a bulk upload, tested directly with
 * fakes (the routes and the operator command both call them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setObjectStorage } from '@aggregator-dpg/object-storage';
import { FakeObjectStorage } from '@aggregator-dpg/object-storage/testing';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { HttpError } from '../../../errors/http-error.js';
import { logger } from '../../../logger.js';
import { _setBulkFileEnqueuer } from '../../bulk-queue/index.js';
import {
  _setBulkUploadsStore,
  BulkUploadsStoreFake,
  buildBulkUpload,
} from '../../bulk-uploads-store/index.js';
import { _setConsentLedger } from '../../consent-ledger/index.js';
import { _setNetworkConfig } from '../../network-config.js';
import { reserveBulkUpload, saveStorageKey, startBulkUpload } from '../index.js';

const { loadConsentConfigMock } = vi.hoisted(() => ({ loadConsentConfigMock: vi.fn() }));

// The consent config loader reads files and has no fake.
vi.mock('@aggregator-dpg/config-loader/fs', () => ({ loadConsentConfig: loadConsentConfigMock }));

const AGG = '00000000-0000-4000-8000-0000000000aa';
const UPLOAD = '00000000-0000-4000-8000-000000000001';
const KEY = `bulk-uploads/${AGG}/${UPLOAD}/raw.csv`;

/** Consent config with the given attestation document, or none. */
function consentConfig(attestation: { current_version: number } | undefined) {
  return {
    audiences: {
      aggregator: {
        documents: {
          terms: { current_version: 1 },
          privacy: { current_version: 1 },
          ...(attestation ? { bulk_upload_attestation: attestation } : {}),
        },
      },
    },
  };
}

/** Awaits `promise` and returns the HttpError code it rejects with. */
async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpError) return err.code;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('bulk-upload service', () => {
  let store: BulkUploadsStoreFake;
  let storage: FakeObjectStorage;
  let ledger: ConsentLedgerFake;
  let enqueued: string[];

  beforeEach(() => {
    _setNetworkConfig(buildBlueDotConfig());
    store = new BulkUploadsStoreFake();
    _setBulkUploadsStore(store);
    storage = new FakeObjectStorage();
    _setObjectStorage(storage);
    ledger = new ConsentLedgerFake();
    _setConsentLedger(ledger);
    enqueued = [];
    _setBulkFileEnqueuer(async (payload) => {
      enqueued.push(payload.uploadId);
    });
    loadConsentConfigMock.mockReset().mockResolvedValue(consentConfig({ current_version: 3 }));
  });

  afterEach(() => {
    _setBulkFileEnqueuer(null);
    _setBulkUploadsStore(null);
    _setConsentLedger(null);
    _setNetworkConfig(null);
    vi.restoreAllMocks();
  });

  describe('reserveBulkUpload', () => {
    const input = {
      aggregatorId: AGG,
      uploadedBy: 'kc-1',
      serves: ['seeker'],
      participantType: 'seeker',
      log: logger,
    };

    it('reserves a pending row and returns where its CSV goes', async () => {
      const { upload, ref } = await reserveBulkUpload(input);
      expect(upload.status).toBe('pending');
      expect(ref).toEqual({
        area: 'bulk-uploads',
        key: `bulk-uploads/${AGG}/${upload.id}/raw.csv`,
      });
      await saveStorageKey(upload.id, ref.key);
      expect(store.get(upload.id)?.storageKey).toBe(ref.key);
    });

    it('refuses a type the coordinator does not serve, creating nothing', async () => {
      const create = vi.spyOn(store, 'create');
      expect(
        await rejectionCode(reserveBulkUpload({ ...input, participantType: 'provider' })),
      ).toBe('DOMAIN_NOT_SERVED');
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('startBulkUpload', () => {
    const start = (attestation: boolean | undefined) =>
      startBulkUpload({ uploadId: UPLOAD, aggregatorId: AGG, attestation, log: logger });

    beforeEach(() => {
      store.seed([buildBulkUpload({ id: UPLOAD, aggregatorId: AGG, storageKey: KEY })]);
      storage.seed({ area: 'bulk-uploads', key: KEY }, Buffer.from('name,phone\nAsha,1\n'));
    });

    it('records the portal attestation source, marks the upload and enqueues it', async () => {
      const outcome = await start(true);
      expect(outcome.kind).toBe('started');
      const [record] = ledger.list();
      expect(record?.subjectId).toBe(AGG);
      expect(record?.source).toBe(`bulk_upload:${UPLOAD}:v3`);
      expect(store.get(UPLOAD)?.status).toBe('uploaded');
      expect(enqueued).toEqual([UPLOAD]);
    });

    it('touches nothing for an upload already past uploaded', async () => {
      store.seed([
        buildBulkUpload({ id: UPLOAD, aggregatorId: AGG, storageKey: KEY, status: 'completed' }),
      ]);
      const stat = vi.spyOn(storage, 'stat');
      const marked = vi.spyOn(store, 'markUploaded');
      const outcome = await start(true);
      expect(outcome.kind).toBe('already_started');
      expect(stat).not.toHaveBeenCalled();
      expect(marked).not.toHaveBeenCalled();
      expect(ledger.list()).toEqual([]);
      expect(enqueued).toEqual([]);
    });

    it('refuses CONSENT_REQUIRED before any storage call', async () => {
      const stat = vi.spyOn(storage, 'stat');
      const del = vi.spyOn(storage, 'delete');
      expect(await rejectionCode(start(false))).toBe('CONSENT_REQUIRED');
      expect(await rejectionCode(start(undefined))).toBe('CONSENT_REQUIRED');
      expect(stat).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
      expect(store.get(UPLOAD)?.status).toBe('pending');
    });

    it('fails closed when the attestation document is not configured', async () => {
      loadConsentConfigMock.mockResolvedValue(consentConfig(undefined));
      expect(await rejectionCode(start(true))).toBe('CONSENT_WRITE_FAILED');
      expect(ledger.list()).toEqual([]);
      expect(store.get(UPLOAD)?.status).toBe('pending');
      expect(enqueued).toEqual([]);
    });

    it('refuses a missing file with SCHEMA_VALIDATION', async () => {
      store.seed([buildBulkUpload({ id: UPLOAD, aggregatorId: AGG, storageKey: `${KEY}.gone` })]);
      expect(await rejectionCode(start(true))).toBe('SCHEMA_VALIDATION');
      expect(enqueued).toEqual([]);
    });

    it('answers FORBIDDEN for another coordinator', async () => {
      expect(
        await rejectionCode(
          startBulkUpload({
            uploadId: UPLOAD,
            aggregatorId: 'other',
            attestation: true,
            log: logger,
          }),
        ),
      ).toBe('FORBIDDEN');
    });
  });
});
