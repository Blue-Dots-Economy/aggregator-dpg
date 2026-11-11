import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError, ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { storageConfigFields } from '../../../config.js';
import type { ObjectRef } from '../../../interface.js';
import { z } from 'zod';

const h = vi.hoisted(() => ({
  clients: [] as Array<{ config: Record<string, unknown>; send: ReturnType<typeof vi.fn> }>,
  sendImpl: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  return {
    S3Client: class {
      readonly send = vi.fn((cmd: unknown, opts?: unknown) => h.sendImpl(cmd, opts));
      constructor(readonly config: Record<string, unknown>) {
        h.clients.push(this);
      }
    },
    GetObjectCommand: command('GetObject'),
    PutObjectCommand: command('PutObject'),
    HeadObjectCommand: command('HeadObject'),
    DeleteObjectCommand: command('DeleteObject'),
    HeadBucketCommand: command('HeadBucket'),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(
    async (
      client: { config: { endpoint: string } },
      cmd: { name: string; input: Record<string, unknown> },
      opts: { expiresIn: number },
    ) => `${client.config.endpoint}/${String(cmd.input.Key)}?op=${cmd.name}&exp=${opts.expiresIn}`,
  ),
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(private readonly opts: { params: { Body: Readable } }) {}
    async done() {
      for await (const chunk of this.opts.params.Body) void chunk;
    }
  },
}));

const { S3ObjectStorage } = await import('../s3.js');
const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

const schema = z.object(storageConfigFields);
const ref: ObjectRef = { area: 'bulk-uploads', key: 'bulk-uploads/x/raw.csv' };

function build(env: Record<string, string> = {}) {
  return new S3ObjectStorage(schema.parse(env));
}

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

beforeEach(() => {
  h.clients.length = 0;
  h.sendImpl.mockReset();
});

describe('S3ObjectStorage', () => {
  describe('stat', () => {
    it('returns size and the unquoted ETag', async () => {
      h.sendImpl.mockResolvedValue({ ContentLength: 10, ETag: '"abc"' });
      const result = await build().stat(ref);
      expect(result.success && result.value).toEqual({ size: 10, fingerprint: 'abc' });
    });

    it.each(['NotFound', 'NoSuchKey'])('returns null for %s', async (name) => {
      h.sendImpl.mockRejectedValue(named(name));
      const result = await build().stat(ref);
      expect(result.success && result.value).toBeNull();
    });

    it('returns an UpstreamError for a timeout', async () => {
      const cause = named('TimeoutError');
      h.sendImpl.mockRejectedValue(cause);
      const result = await build().stat(ref);
      expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
      expect(!result.success && result.error.cause).toBe(cause);
    });

    it('queries the full stored key through the internal client', async () => {
      h.sendImpl.mockResolvedValue({ ContentLength: 1, ETag: '"a"' });
      await build({
        S3_ENDPOINT: 'http://internal:9000',
        S3_PUBLIC_ENDPOINT: 'http://pub:9000',
      }).stat(ref);
      const [internal, presigner] = h.clients;
      expect(internal?.send).toHaveBeenCalledTimes(1);
      expect(presigner?.send).not.toHaveBeenCalled();
      expect(internal?.send.mock.calls[0]?.[0].input).toMatchObject({
        Bucket: 'aggregator-bulk-uploads',
        Key: 'bulk-uploads/x/raw.csv',
      });
    });
  });

  describe('createUpload', () => {
    it('signs with the public endpoint and the content type', async () => {
      const result = await build({
        S3_ENDPOINT: 'http://internal:9000',
        S3_PUBLIC_ENDPOINT: 'http://public.example:9000',
      }).createUpload({ ref, contentType: 'text/csv', maxBytes: 5, expiresInSeconds: 300 });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(new URL(result.value.url).host).toBe('public.example:9000');
      expect(result.value).toMatchObject({
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        formFields: {},
      });
      const command = vi.mocked(getSignedUrl).mock.calls.at(-1)?.[1] as unknown as {
        input: Record<string, unknown>;
      };
      expect(command.input).toMatchObject({
        ContentType: 'text/csv',
        Key: 'bulk-uploads/x/raw.csv',
      });
    });

    it('falls back to the internal endpoint when no public endpoint is set', async () => {
      const result = await build({ S3_ENDPOINT: 'http://internal:9000' }).createUpload({
        ref,
        contentType: 'text/csv',
        maxBytes: 5,
        expiresInSeconds: 300,
      });
      expect(result.success && new URL(result.value.url).host).toBe('internal:9000');
    });
  });

  it('signs downloads with an attachment disposition and content type', async () => {
    const result = await build({ S3_ENDPOINT: 'http://internal:9000' }).createDownloadUrl({
      ref,
      expiresInSeconds: 60,
      filename: 'errors.csv',
      contentType: 'text/csv',
    });
    expect(result.success).toBe(true);
    const command = vi.mocked(getSignedUrl).mock.calls.at(-1)?.[1] as unknown as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      ResponseContentDisposition: 'attachment; filename="errors.csv"',
      ResponseContentType: 'text/csv',
    });
  });

  describe('put', () => {
    it('sends a buffer with an abort signal', async () => {
      h.sendImpl.mockResolvedValue({});
      const result = await build().put({ ref, body: Buffer.from('x'), contentType: 'text/csv' });
      expect(result.success).toBe(true);
      const [command, opts] = h.sendImpl.mock.calls[0] ?? [];
      expect(command.name).toBe('PutObject');
      expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('aborts a buffered put after the configured write timeout', async () => {
      h.sendImpl.mockResolvedValue({});
      await build({ STORAGE_WRITE_TIMEOUT_MS: '1' }).put({
        ref,
        body: Buffer.from('x'),
        contentType: 'text/csv',
      });
      const signal: AbortSignal = h.sendImpl.mock.calls[0]?.[1].abortSignal;
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
    });

    it('returns an UpstreamError when a buffered put fails', async () => {
      h.sendImpl.mockRejectedValue(named('TimeoutError'));
      const result = await build().put({ ref, body: Buffer.from('x'), contentType: 'text/csv' });
      expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
    });

    it('returns an UpstreamError when the streamed source errors', async () => {
      const body = new Readable({ read() {} });
      const pending = build().put({ ref, body, contentType: 'text/csv' });
      body.destroy(new Error('source broke'));
      const result = await pending;
      expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
    });
  });

  it('deletes the full stored key', async () => {
    h.sendImpl.mockResolvedValue({});
    const result = await build().delete(ref);
    expect(result.success).toBe(true);
    const [command] = h.sendImpl.mock.calls[0] ?? [];
    expect(command.name).toBe('DeleteObject');
    expect(command.input.Key).toBe('bulk-uploads/x/raw.csv');
  });

  it('maps NoSuchKey to null on openReadStream', async () => {
    h.sendImpl.mockRejectedValue(named('NoSuchKey'));
    const result = await build().openReadStream(ref);
    expect(result.success && result.value).toBeNull();
  });

  it('returns null from stat when the object has no ETag', async () => {
    h.sendImpl.mockResolvedValue({ ContentLength: 3 });
    const result = await build().stat(ref);
    expect(result.success && result.value).toBeNull();
  });

  it('reports size 0 from stat when ContentLength is missing', async () => {
    h.sendImpl.mockResolvedValue({ ETag: '"abc"' });
    const result = await build().stat(ref);
    expect(result.success && result.value).toEqual({ size: 0, fingerprint: 'abc' });
  });

  it('returns the body stream from openReadStream', async () => {
    const body = Readable.from(['x']);
    h.sendImpl.mockResolvedValue({ Body: body });
    const result = await build().openReadStream(ref);
    expect(result.success && result.value).toBe(body);
  });

  it('returns an UpstreamError when the object body is missing', async () => {
    h.sendImpl.mockResolvedValue({});
    const result = await build().openReadStream(ref);
    expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
  });

  it('returns an UpstreamError when the object body is not a Node stream', async () => {
    h.sendImpl.mockResolvedValue({ Body: 'text' });
    const result = await build().openReadStream(ref);
    expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
  });

  it('returns an UpstreamError for other openReadStream failures', async () => {
    h.sendImpl.mockRejectedValue(named('AccessDenied'));
    const result = await build().openReadStream(ref);
    expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
  });

  it('returns an UpstreamError when signing an upload fails', async () => {
    vi.mocked(getSignedUrl).mockRejectedValueOnce(new Error('sign failed'));
    const result = await build().createUpload({
      ref,
      contentType: 'text/csv',
      maxBytes: 5,
      expiresInSeconds: 300,
    });
    expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
  });

  it('returns an UpstreamError when signing a download fails', async () => {
    vi.mocked(getSignedUrl).mockRejectedValueOnce(new Error('sign failed'));
    const result = await build().createDownloadUrl({
      ref,
      expiresInSeconds: 60,
      filename: 'errors.csv',
      contentType: 'text/csv',
    });
    expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
  });

  it('returns an UpstreamError when delete fails', async () => {
    h.sendImpl.mockRejectedValue(named('AccessDenied'));
    const result = await build().delete(ref);
    expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
  });

  it('returns an UpstreamError when the health check fails', async () => {
    h.sendImpl.mockRejectedValue(named('NoSuchBucket'));
    const result = await build().checkHealth();
    expect(!result.success && result.error).toBeInstanceOf(UpstreamError);
  });

  it('checks health with HeadBucket', async () => {
    h.sendImpl.mockResolvedValue({});
    expect((await build().checkHealth()).success).toBe(true);
    expect(h.sendImpl.mock.calls[0]?.[0].name).toBe('HeadBucket');
  });

  it('rejects a key outside its area on every operation without calling storage', async () => {
    const storage = build();
    const outside: ObjectRef = { area: 'exports', key: 'bulk-uploads/x/raw.csv' };
    const results = [
      await storage.createUpload({
        ref: outside,
        contentType: 'text/csv',
        maxBytes: 5,
        expiresInSeconds: 300,
      }),
      await storage.createDownloadUrl({
        ref: outside,
        expiresInSeconds: 60,
        filename: 'errors.csv',
        contentType: 'text/csv',
      }),
      await storage.stat(outside),
      await storage.openReadStream(outside),
      await storage.put({ ref: outside, body: Buffer.from('x'), contentType: 'text/csv' }),
      await storage.delete(outside),
    ];
    for (const result of results) {
      expect(!result.success && result.error).toBeInstanceOf(ValidationError);
    }
    expect(h.sendImpl).not.toHaveBeenCalled();
  });

  describe('client construction', () => {
    it('omits credentials when the keys are blank', () => {
      build({ S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' });
      expect(h.clients[0]?.config).not.toHaveProperty('credentials');
    });

    it('omits credentials when only one key is set', () => {
      build({ S3_ACCESS_KEY_ID: 'id' });
      expect(h.clients[0]?.config).not.toHaveProperty('credentials');
    });

    it('passes credentials when both keys are set', () => {
      build({ S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' });
      expect(h.clients[0]?.config.credentials).toEqual({
        accessKeyId: 'id',
        secretAccessKey: 'secret',
      });
    });

    it('applies configured retries and connect timeout', () => {
      build({ STORAGE_MAX_ATTEMPTS: '5', STORAGE_CONNECT_TIMEOUT_MS: '1234' });
      expect(h.clients[0]?.config).toMatchObject({
        maxAttempts: 5,
        requestHandler: { connectionTimeout: 1234 },
      });
    });
  });
});
