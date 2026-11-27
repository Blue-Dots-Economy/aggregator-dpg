/**
 * Unit tests for the dump's S3 reads (`dump-storage.ts`).
 *
 * `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are mocked (per
 * testing.md §1 — third-party adapters may be stubbed) so no real S3/MinIO
 * call is ever made. `../../config.js` is also mocked so each test controls
 * the S3 endpoint/credential permutations deterministically. Covers the
 * internal-vs-presigner client split, credential injection, the
 * NotFound/NoSuchKey → null mapping on `headObject`, the transport-error
 * rethrow path, `signDownloadUrl` signing against the PUBLIC endpoint client
 * with the caller's TTL, and `ObjectHead.lastModified` being present/absent
 * per the SDK response.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const s3ClientCtorCalls: Array<Record<string, unknown>> = [];
const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    opts: Record<string, unknown>;
    send = sendMock;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      s3ClientCtorCalls.push(opts);
    }
  }
  class MockCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    S3Client: MockS3Client,
    HeadObjectCommand: class extends MockCommand {},
    GetObjectCommand: class extends MockCommand {},
  };
});

const getSignedUrlMock = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}));

const baseConfig = {
  S3_REGION: 'ap-south-1',
  S3_ENDPOINT: 'http://minio-internal:9000',
  S3_PUBLIC_ENDPOINT: undefined as string | undefined,
  S3_BUCKET: 'aggregator-bulk-uploads',
  S3_ACCESS_KEY_ID: undefined as string | undefined,
  S3_SECRET_ACCESS_KEY: undefined as string | undefined,
  S3_FORCE_PATH_STYLE: true,
  STORAGE_MAX_ATTEMPTS: 3,
  STORAGE_CONNECT_TIMEOUT_MS: 5000,
};

vi.mock('../../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

let mockConfig = { ...baseConfig };

describe('dump-storage', () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    getSignedUrlMock.mockReset();
    s3ClientCtorCalls.length = 0;
    mockConfig = { ...baseConfig };
  });

  describe('client construction', () => {
    it('builds the internal client from S3_ENDPOINT without credentials when unset', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockResolvedValue({ ETag: '"abc"', ContentLength: 10 });
      await headObject('some/key');
      expect(s3ClientCtorCalls).toHaveLength(1);
      expect(s3ClientCtorCalls[0]).toMatchObject({
        region: 'ap-south-1',
        endpoint: 'http://minio-internal:9000',
        forcePathStyle: true,
      });
      expect(s3ClientCtorCalls[0]).not.toHaveProperty('credentials');
    });

    it('includes credentials when both access key and secret are set', async () => {
      mockConfig.S3_ACCESS_KEY_ID = 'AKIA123';
      mockConfig.S3_SECRET_ACCESS_KEY = 'secret123';
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockResolvedValue({ ETag: '"abc"', ContentLength: 1 });
      await headObject('k');
      expect(s3ClientCtorCalls[0]).toMatchObject({
        credentials: { accessKeyId: 'AKIA123', secretAccessKey: 'secret123' },
      });
    });

    it('reuses the cached internal client across calls', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockResolvedValue({ ETag: '"abc"', ContentLength: 1 });
      await headObject('k1');
      await headObject('k2');
      expect(s3ClientCtorCalls).toHaveLength(1);
    });

    it('falls back to S3_ENDPOINT for the presigner client when S3_PUBLIC_ENDPOINT is unset', async () => {
      const { signDownloadUrl } = await import('./dump-storage.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/dump');
      await signDownloadUrl('k', { ttlSeconds: 60 });
      expect(s3ClientCtorCalls[0]).toMatchObject({ endpoint: 'http://minio-internal:9000' });
    });

    it('uses S3_PUBLIC_ENDPOINT for the presigner client when set, distinct from the internal client', async () => {
      mockConfig.S3_PUBLIC_ENDPOINT = 'https://public.example.com';
      const { signDownloadUrl, headObject } = await import('./dump-storage.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/dump');
      sendMock.mockResolvedValue({ ETag: '"x"', ContentLength: 1 });
      await signDownloadUrl('k', { ttlSeconds: 60 });
      await headObject('k');
      expect(s3ClientCtorCalls).toHaveLength(2);
      expect(s3ClientCtorCalls[0]).toMatchObject({ endpoint: 'https://public.example.com' });
      expect(s3ClientCtorCalls[1]).toMatchObject({ endpoint: 'http://minio-internal:9000' });
    });

    it('_resetDumpStorageClients forces fresh clients on the next call', async () => {
      const { headObject, _resetDumpStorageClients } = await import('./dump-storage.js');
      sendMock.mockResolvedValue({ ETag: '"x"', ContentLength: 1 });
      await headObject('k1');
      _resetDumpStorageClients();
      await headObject('k2');
      expect(s3ClientCtorCalls).toHaveLength(2);
    });
  });

  describe('headObject', () => {
    it('returns etag (unquoted) and contentLength on success', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockResolvedValue({ ETag: '"quoted-etag"', ContentLength: 1234 });
      const result = await headObject('bulk-uploads/agg-1/up-1/raw.csv');
      expect(result).toEqual({ etag: 'quoted-etag', contentLength: 1234 });
    });

    it('defaults contentLength to 0 when the SDK omits it', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockResolvedValue({ ETag: '"e"' });
      const result = await headObject('k');
      expect(result?.contentLength).toBe(0);
    });

    it('returns null when the SDK response has no ETag', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockResolvedValue({});
      const result = await headObject('k');
      expect(result).toBeNull();
    });

    it('returns null on a NotFound error', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockRejectedValue({ name: 'NotFound' });
      const result = await headObject('missing-key');
      expect(result).toBeNull();
    });

    it('returns null on a NoSuchKey error', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockRejectedValue({ name: 'NoSuchKey' });
      const result = await headObject('missing-key');
      expect(result).toBeNull();
    });

    it('rethrows on any other transport error', async () => {
      const { headObject } = await import('./dump-storage.js');
      const err = new Error('connection refused');
      sendMock.mockRejectedValue(err);
      await expect(headObject('k')).rejects.toThrow('connection refused');
    });

    it('rethrows a non-object thrown value untouched', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockRejectedValue('raw string failure');
      await expect(headObject('k')).rejects.toBe('raw string failure');
    });
  });

  describe('signDownloadUrl', () => {
    it('signs against S3_PUBLIC_ENDPOINT, not the internal S3_ENDPOINT', async () => {
      mockConfig.S3_PUBLIC_ENDPOINT = 'https://public.example.com';
      const { signDownloadUrl } = await import('./dump-storage.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/dump-key');
      const result = await signDownloadUrl('blue_dot/blue_dot_up/user.ndjson.gz', {
        ttlSeconds: 600,
      });
      expect(result.url).toBe('https://signed.example/dump-key');
      expect(result.key).toBe('blue_dot/blue_dot_up/user.ndjson.gz');
      // The client the URL was signed against — never the internal endpoint —
      // is what determines the host baked into the presigned URL.
      expect(s3ClientCtorCalls).toHaveLength(1);
      expect(s3ClientCtorCalls[0]).toMatchObject({ endpoint: 'https://public.example.com' });
    });

    it("expiresAt tracks the caller's ttlSeconds, not a hardcoded default", async () => {
      const { signDownloadUrl } = await import('./dump-storage.js');
      getSignedUrlMock.mockResolvedValue('https://signed.example/dump-key');
      const before = Date.now();
      const result = await signDownloadUrl('k', { ttlSeconds: 137 });
      const expiresAt = new Date(result.expiresAt).getTime();
      expect(expiresAt - before).toBeGreaterThanOrEqual(137_000 - 1000);
      expect(expiresAt - before).toBeLessThan(137_000 + 5000);
    });
  });

  describe('headObject lastModified', () => {
    it('surfaces LastModified when the SDK provides it', async () => {
      const { headObject } = await import('./dump-storage.js');
      const lastModified = new Date('2026-08-26T00:30:58.000Z');
      sendMock.mockResolvedValue({ ETag: '"e"', ContentLength: 10, LastModified: lastModified });
      const result = await headObject('k');
      expect(result?.lastModified).toEqual(lastModified);
    });

    it('omits lastModified when the SDK response has no LastModified', async () => {
      const { headObject } = await import('./dump-storage.js');
      sendMock.mockResolvedValue({ ETag: '"e"', ContentLength: 10 });
      const result = await headObject('k');
      expect(result).not.toHaveProperty('lastModified');
    });
  });
});
