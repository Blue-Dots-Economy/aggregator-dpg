import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { fromStoredKey, toStoredKey } from '../areas.js';
import { storageConfigFields } from '../config.js';
import { runObjectStorageContract } from '../contract-suite.js';
import { FakeObjectStorage } from '../testing.js';

describe('areas', () => {
  it('maps bulk-uploads refs to the bulk-uploads prefix', () => {
    expect(toStoredKey({ area: 'bulk-uploads', key: 'a/b/raw.csv' })).toBe(
      'bulk-uploads/a/b/raw.csv',
    );
  });

  it('maps exports refs to the campaign-exports prefix', () => {
    expect(toStoredKey({ area: 'exports', key: 'o/j.csv' })).toBe('campaign-exports/o/j.csv');
  });

  it('parses a stored key back into a ref', () => {
    const result = fromStoredKey('bulk-uploads', 'bulk-uploads/x/errors.csv');
    expect(result.success && result.value).toEqual({ area: 'bulk-uploads', key: 'x/errors.csv' });
  });

  it.each(['pending', 'campaign-exports/x', 'bulk-uploads/'])('rejects %s', (stored) => {
    const result = fromStoredKey('bulk-uploads', stored);
    expect(!result.success && result.error).toBeInstanceOf(ValidationError);
  });
});

describe('storageConfigFields', () => {
  const schema = z.object(storageConfigFields);

  it('applies defaults', () => {
    expect(schema.parse({})).toMatchObject({
      STORAGE_PROVIDER: 's3',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'aggregator-bulk-uploads',
      S3_FORCE_PATH_STYLE: true,
      STORAGE_CONNECT_TIMEOUT_MS: 5000,
      STORAGE_MAX_ATTEMPTS: 3,
      STORAGE_WRITE_TIMEOUT_MS: 60000,
    });
  });

  it('rejects an unknown provider', () => {
    expect(() => schema.parse({ STORAGE_PROVIDER: 'azure' })).toThrow();
  });
});

runObjectStorageContract('fake', async () => {
  const storage = new FakeObjectStorage();
  return {
    storage,
    seed: async (ref, bytes) => {
      storage.seed(ref, bytes);
    },
  };
});

describe('FakeObjectStorage', () => {
  const ref = { area: 'bulk-uploads', key: 'a/raw.csv' } as const;

  it('fails the next call once with the given error, then recovers', async () => {
    const storage = new FakeObjectStorage();
    const failure = new ValidationError('boom');
    storage.failNext('stat', failure);
    const first = await storage.stat(ref);
    expect(!first.success && first.error).toBe(failure);
    const second = await storage.stat(ref);
    expect(second.success && second.value).toBeNull();
  });

  it('exposes seeded bytes through read', () => {
    const storage = new FakeObjectStorage();
    storage.seed(ref, Buffer.from('hi'));
    expect(storage.read(ref)?.toString()).toBe('hi');
    expect(storage.read({ area: 'exports', key: 'a/raw.csv' })).toBeUndefined();
  });

  it('builds fake:// upload instructions on the stored key', async () => {
    const result = await new FakeObjectStorage().createUpload({
      ref,
      contentType: 'text/csv',
      maxBytes: 10,
      expiresInSeconds: 60,
    });
    expect(result.success && result.value).toMatchObject({
      method: 'PUT',
      url: 'fake://bulk-uploads/a/raw.csv',
      headers: { 'Content-Type': 'text/csv' },
      formFields: {},
    });
  });
});
