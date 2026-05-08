/**
 * Tests for FileSchemaLoader.
 *
 * Layout used:
 *   {tmp}/aggregator/registration.v1.json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileSchemaLoader } from '../file-loader.js';
import { SchemaLoaderFake } from '../testing/index.js';

const sampleSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['email'],
  properties: {
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;

describe('FileSchemaLoader', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'schema-loader-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('loads and caches a schema by id+version', async () => {
    const dir = path.join(rootDir, 'aggregator');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'registration.v1.json'), JSON.stringify(sampleSchema), 'utf8');

    const loader = new FileSchemaLoader({ rootDir });
    const ref = { id: 'aggregator-registration', version: 'v1' };

    const first = await loader.getSchema(ref);
    expect(first.success).toBe(true);
    if (first.success) {
      expect(first.value.type).toBe('object');
    }

    // Second call returns cached value (same reference).
    const second = await loader.getSchema(ref);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.value).toBe(first.value);
    }
  });

  it('compiles and caches a validator by id+version', async () => {
    const dir = path.join(rootDir, 'aggregator');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'registration.v1.json'), JSON.stringify(sampleSchema), 'utf8');

    const loader = new FileSchemaLoader({ rootDir });
    const ref = { id: 'aggregator-registration', version: 'v1' };

    const result = await loader.getValidator(ref);
    expect(result.success).toBe(true);
    if (result.success) {
      const validate = result.value;
      expect(validate({ email: 'asha@example.com' })).toBe(true);
      expect(validate({ email: 'not-an-email' })).toBe(false);
      expect(validate({})).toBe(false);
    }

    // Caching: second call returns same validator instance.
    const second = await loader.getValidator(ref);
    if (result.success && second.success) {
      expect(second.value).toBe(result.value);
    }
  });

  it('returns SCHEMA_NOT_FOUND when the file does not exist', async () => {
    const loader = new FileSchemaLoader({ rootDir });
    const ref = { id: 'missing-thing', version: 'v1' };

    const result = await loader.getSchema(ref);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('SCHEMA_NOT_FOUND');
    }
  });

  it('returns SCHEMA_COMPILE_ERROR for malformed JSON', async () => {
    const dir = path.join(rootDir, 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'thing.v1.json'), '{ this is not json', 'utf8');

    const loader = new FileSchemaLoader({ rootDir });
    const result = await loader.getSchema({ id: 'broken-thing', version: 'v1' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('SCHEMA_COMPILE_ERROR');
    }
  });
});

describe('SchemaLoaderFake', () => {
  it('serves seeded schemas and compiles validators', async () => {
    const fake = new SchemaLoaderFake();
    fake.seed([{ ref: { id: 'participant-seeker', version: 'v1' }, schema: sampleSchema }]);

    const validatorResult = await fake.getValidator({
      id: 'participant-seeker',
      version: 'v1',
    });
    expect(validatorResult.success).toBe(true);
    if (validatorResult.success) {
      expect(validatorResult.value({ email: 'a@b.co', age: 22 })).toBe(true);
      expect(validatorResult.value({ age: -1 })).toBe(false);
    }
  });

  it('returns SCHEMA_NOT_FOUND for unseeded refs', async () => {
    const fake = new SchemaLoaderFake();
    const result = await fake.getValidator({ id: 'missing', version: 'v1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('SCHEMA_NOT_FOUND');
    }
  });
});
