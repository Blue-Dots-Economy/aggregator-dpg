import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { fromStoredKey, toStoredKey } from '../areas.js';
import { storageConfigFields } from '../config.js';

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
