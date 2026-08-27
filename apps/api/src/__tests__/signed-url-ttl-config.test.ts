/**
 * Boot-time guards on the pre-signed URL TTL surface.
 *
 * `apps/api/src/config.ts` parses `process.env` at import time, so these
 * exercise the real schema fields through a fresh module import rather than
 * mirroring the shape — a mirror would keep passing if the config stopped using
 * the bounded schema.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as ConfigModule from '../config.js';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgres://localhost:5432/aggregator_test',
};

async function loadConfig(
  ttlEnv: Record<string, string | undefined>,
): Promise<typeof ConfigModule> {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...REQUIRED_ENV, ...ttlEnv })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../config.js');
}

const TTL_KEYS = [
  'SIGNED_URL_TTL_SECONDS',
  'BULK_UPLOAD_URL_TTL_SECONDS',
  'ERRORS_CSV_DOWNLOAD_URL_TTL_SECONDS',
  'QR_DOWNLOAD_URL_TTL_SECONDS',
];

describe('signed-url TTL config', () => {
  beforeEach(() => {
    for (const k of TTL_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of TTL_KEYS) delete process.env[k];
    vi.resetModules();
  });

  it('defaults every class to ten minutes when nothing is set', async () => {
    const { signedUrlTtlSeconds } = await loadConfig({});
    expect(signedUrlTtlSeconds).toEqual({
      bulkUpload: 600,
      errorsCsvDownload: 600,
      qrDownload: 600,
    });
  });

  it('applies the canonical value to every class', async () => {
    const { signedUrlTtlSeconds } = await loadConfig({ SIGNED_URL_TTL_SECONDS: '300' });
    expect(signedUrlTtlSeconds).toEqual({
      bulkUpload: 300,
      errorsCsvDownload: 300,
      qrDownload: 300,
    });
  });

  it('lets each class be overridden independently of the others', async () => {
    const { signedUrlTtlSeconds } = await loadConfig({
      SIGNED_URL_TTL_SECONDS: '600',
      BULK_UPLOAD_URL_TTL_SECONDS: '1800',
      QR_DOWNLOAD_URL_TTL_SECONDS: '60',
    });
    expect(signedUrlTtlSeconds).toEqual({
      bulkUpload: 1800,
      errorsCsvDownload: 600,
      qrDownload: 60,
    });
  });

  // A pre-signed URL cannot be revoked, so an over-ceiling TTL is
  // indistinguishable from publishing a durable public URL. Boot must refuse it
  // rather than clamp: a deploy that fails to start is recoverable in minutes,
  // a bucket readable for a week is not.
  it.each(['3601', '86400', '604800'])('refuses to boot with a TTL of %s seconds', async (v) => {
    await expect(loadConfig({ SIGNED_URL_TTL_SECONDS: v })).rejects.toThrow();
  });

  it('refuses to boot when an empty value is rendered for the canonical TTL', async () => {
    // A chart that emits SIGNED_URL_TTL_SECONDS: "" would coerce to 0.
    await expect(loadConfig({ SIGNED_URL_TTL_SECONDS: '' })).rejects.toThrow();
  });

  it.each(['0', '-1', 'abc'])('refuses to boot with a TTL of %s', async (v) => {
    await expect(loadConfig({ SIGNED_URL_TTL_SECONDS: v })).rejects.toThrow();
  });

  it('applies the same ceiling to a per-class override', async () => {
    await expect(loadConfig({ QR_DOWNLOAD_URL_TTL_SECONDS: '86400' })).rejects.toThrow();
  });
});
