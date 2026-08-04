/**
 * Unit tests for the worker's S3 client wrapper.
 *
 * `@aws-sdk/client-s3` is mocked so no real S3/MinIO call is ever made (per
 * root CLAUDE.md — S3 has no local/test double in compose). Each test
 * re-imports the module fresh via `vi.resetModules()` so the module-level
 * cached client is rebuilt against that test's mocked config.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const sendMock = vi.fn();
const s3ClientCtorCalls: unknown[] = [];
const commandCalls: Array<{ type: string; input: unknown }> = [];

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    opts: unknown;
    send = sendMock;
    constructor(opts: unknown) {
      this.opts = opts;
      s3ClientCtorCalls.push(opts);
    }
  }
  class GetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
      commandCalls.push({ type: 'GetObject', input });
    }
  }
  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
      commandCalls.push({ type: 'PutObject', input });
    }
  }
  return { S3Client, GetObjectCommand, PutObjectCommand };
});

let configMock: Record<string, unknown>;
vi.mock('./config.js', () => ({
  config: new Proxy(
    {},
    {
      get(_t, prop: string) {
        return configMock[prop];
      },
    },
  ),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  s3ClientCtorCalls.length = 0;
  commandCalls.length = 0;
  configMock = {
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'aggregator-bulk-uploads',
    S3_FORCE_PATH_STYLE: true,
    S3_ENDPOINT: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
  };
});

describe('getCsvStream', () => {
  it('returns the object Body as a Readable on success', async () => {
    const body = Readable.from([Buffer.from('a,b\n1,2')]);
    sendMock.mockResolvedValueOnce({ Body: body });
    const { getCsvStream } = await import('./object-storage.js');

    const result = await getCsvStream('bulk-uploads/agg-1/up-1/raw.csv');

    expect(result).toBe(body);
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toEqual({
      type: 'GetObject',
      input: { Bucket: 'aggregator-bulk-uploads', Key: 'bulk-uploads/agg-1/up-1/raw.csv' },
    });
  });

  it('throws when the object has no Body', async () => {
    sendMock.mockResolvedValueOnce({ Body: undefined });
    const { getCsvStream } = await import('./object-storage.js');

    await expect(getCsvStream('missing.csv')).rejects.toThrow(
      /empty body for s3 key: missing\.csv/,
    );
  });

  it('propagates transport failures (no silent swallowing)', async () => {
    sendMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { getCsvStream } = await import('./object-storage.js');

    await expect(getCsvStream('up-1/raw.csv')).rejects.toThrow('ECONNREFUSED');
  });

  it('reuses a single cached S3Client across multiple calls', async () => {
    sendMock.mockResolvedValue({ Body: Readable.from([Buffer.from('x')]) });
    const { getCsvStream } = await import('./object-storage.js');

    await getCsvStream('a.csv');
    await getCsvStream('b.csv');

    expect(s3ClientCtorCalls).toHaveLength(1);
  });
});

describe('putObject', () => {
  it('uploads with the given key, body, and content type', async () => {
    sendMock.mockResolvedValueOnce({});
    const { putObject } = await import('./object-storage.js');

    const body = Buffer.from('id,status\n1,ok');
    await putObject('bulk-uploads/agg-1/up-1/errors.csv', body, 'text/csv');

    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toEqual({
      type: 'PutObject',
      input: {
        Bucket: 'aggregator-bulk-uploads',
        Key: 'bulk-uploads/agg-1/up-1/errors.csv',
        Body: body,
        ContentType: 'text/csv',
      },
    });
  });

  it('propagates upload failures', async () => {
    sendMock.mockRejectedValueOnce(new Error('AccessDenied'));
    const { putObject } = await import('./object-storage.js');

    await expect(putObject('k', Buffer.from('x'), 'text/csv')).rejects.toThrow('AccessDenied');
  });
});

describe('S3Client construction', () => {
  it('applies explicit S3_ENDPOINT + credentials when configured (MinIO / static-key posture)', async () => {
    configMock.S3_ENDPOINT = 'http://minio:9000';
    configMock.S3_ACCESS_KEY_ID = 'minioadmin';
    configMock.S3_SECRET_ACCESS_KEY = 'minioadmin-secret';
    sendMock.mockResolvedValueOnce({});
    const { putObject } = await import('./object-storage.js');

    await putObject('k', Buffer.from('x'), 'text/csv');

    expect(s3ClientCtorCalls[0]).toMatchObject({
      region: 'us-east-1',
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5_000 },
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin-secret' },
    });
  });

  it('omits endpoint + credentials when unset (real S3 via IAM role posture)', async () => {
    sendMock.mockResolvedValueOnce({});
    const { putObject } = await import('./object-storage.js');

    await putObject('k', Buffer.from('x'), 'text/csv');

    const opts = s3ClientCtorCalls[0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('endpoint');
    expect(opts).not.toHaveProperty('credentials');
  });
});
