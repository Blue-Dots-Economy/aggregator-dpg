import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { buildKey, checkRef } from '../areas.js';
import { storageConfigFields } from '../config.js';
import type { ObjectRef } from '../interface.js';
import { runObjectStorageContract } from '../contract-suite.js';
import { FakeObjectStorage } from '../testing.js';
import { _setObjectStorage, getObjectStorage, initObjectStorage } from '../index.js';

describe('areas', () => {
  it('builds bulk-uploads keys with the owner first', () => {
    expect(buildKey('bulk-uploads', 'agg-1', 'up-1', 'raw.csv')).toBe(
      'bulk-uploads/agg-1/up-1/raw.csv',
    );
  });

  it('builds exports keys under the campaign-exports prefix', () => {
    expect(buildKey('exports', 'org-1', 'job-1.csv')).toBe('campaign-exports/org-1/job-1.csv');
  });

  it('accepts a key inside its area', () => {
    const result = checkRef({ area: 'exports', key: 'campaign-exports/o/j.csv' });
    expect(result.success && result.value).toBe('campaign-exports/o/j.csv');
  });

  it.each(['nope', 'toString'])('rejects the unknown area %s', (area) => {
    const ref: ObjectRef = { area: 'exports', key: 'campaign-exports/o/j.csv' };
    Reflect.set(ref, 'area', area);
    const result = checkRef(ref);
    expect(!result.success && result.error).toBeInstanceOf(ValidationError);
  });

  it.each(['pending', 'campaign-exports/x', 'bulk-uploads/', 'x/bulk-uploads/a'])(
    'rejects the bulk-uploads key %s',
    (key) => {
      const result = checkRef({ area: 'bulk-uploads', key });
      expect(!result.success && result.error).toBeInstanceOf(ValidationError);
    },
  );
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
  const ref: ObjectRef = { area: 'bulk-uploads', key: 'bulk-uploads/a/raw.csv' };

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
    expect(storage.read({ area: 'bulk-uploads', key: 'bulk-uploads/b/raw.csv' })).toBeUndefined();
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

describe('provider factory', () => {
  const cfg = z.object(storageConfigFields).parse({});

  beforeEach(() => _setObjectStorage(null));

  it('throws ConfigError before initialisation', () => {
    expect(() => getObjectStorage()).toThrow(ConfigError);
  });

  it('builds the provider once and returns the same instance', () => {
    const first = initObjectStorage(cfg);
    expect(initObjectStorage(cfg)).toBe(first);
    expect(getObjectStorage()).toBe(first);
  });

  it('lets a test override the provider', () => {
    const fake = new FakeObjectStorage();
    _setObjectStorage(fake);
    expect(getObjectStorage()).toBe(fake);
  });
});
