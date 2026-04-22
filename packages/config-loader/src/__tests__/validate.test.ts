import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildCompositeSchema, validateConfig } from '../validate.js';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import type { RegisteredPackage } from '../discovery.js';

function makeRegistry(
  entries: Array<{ key: string; schema: z.ZodTypeAny }>,
): ReadonlyMap<string, RegisteredPackage> {
  return new Map(
    entries.map(({ key, schema }) => [
      key,
      { packageName: `@test/${key}`, configKey: key, configSchema: schema },
    ]),
  );
}

describe('buildCompositeSchema', () => {
  it('builds schema with one package', () => {
    const registry = makeRegistry([{ key: 'db', schema: z.object({ host: z.string() }) }]);
    const schema = buildCompositeSchema(registry);
    const result = schema.safeParse({ db: { host: 'localhost' } });
    expect(result.success).toBe(true);
  });

  it('builds schema with multiple packages', () => {
    const registry = makeRegistry([
      { key: 'db', schema: z.object({ host: z.string() }) },
      { key: 'auth', schema: z.object({ secret: z.string() }) },
    ]);
    const schema = buildCompositeSchema(registry);
    const result = schema.safeParse({ db: { host: 'localhost' }, auth: { secret: 'abc' } });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys (strict mode)', () => {
    const registry = makeRegistry([{ key: 'db', schema: z.object({ host: z.string() }) }]);
    const schema = buildCompositeSchema(registry);
    const result = schema.safeParse({ db: { host: 'x' }, unknownKey: 'value' });
    expect(result.success).toBe(false);
  });

  it('falls back to z.unknown() for non-Zod schemas', () => {
    const fakeSchema = {
      parse: () => ({}),
      safeParse: (v: unknown) => ({ success: true, data: v }),
    };
    const registry = makeRegistry([{ key: 'pkg', schema: fakeSchema as unknown as z.ZodTypeAny }]);
    const schema = buildCompositeSchema(registry);
    // z.unknown() accepts anything
    const result = schema.safeParse({ pkg: { anything: 'goes' } });
    expect(result.success).toBe(true);
  });
});

describe('validateConfig', () => {
  it('returns config unchanged when registry is empty', () => {
    const config = { arbitrary: 'value' };
    const result = validateConfig(config, new Map());
    expect(result).toEqual(config);
  });

  it('returns validated config on success', () => {
    const registry = makeRegistry([{ key: 'db', schema: z.object({ port: z.number() }) }]);
    const result = validateConfig({ db: { port: 5432 } }, registry);
    expect(result).toEqual({ db: { port: 5432 } });
  });

  it('returns Zod-coerced values', () => {
    const registry = makeRegistry([
      { key: 'svc', schema: z.object({ startedAt: z.coerce.date() }) },
    ]);
    const result = validateConfig({ svc: { startedAt: '2024-01-01T00:00:00Z' } }, registry);
    expect((result['svc'] as { startedAt: Date }).startedAt).toBeInstanceOf(Date);
  });

  it('throws ConfigError on validation failure', () => {
    const registry = makeRegistry([{ key: 'db', schema: z.object({ host: z.string() }) }]);
    expect(() => validateConfig({ db: { host: 42 } }, registry)).toThrow(ConfigError);
  });

  it('thrown error has code CONFIG_VALIDATION_ERROR', () => {
    const registry = makeRegistry([{ key: 'db', schema: z.object({ host: z.string() }) }]);
    try {
      validateConfig({ db: { host: 42 } }, registry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('CONFIG_VALIDATION_ERROR');
    }
  });

  it('aggregates multiple errors into one ConfigError', () => {
    const registry = makeRegistry([
      {
        key: 'svc',
        schema: z.object({ host: z.string(), port: z.number(), secret: z.string() }),
      },
    ]);
    try {
      validateConfig({ svc: { host: 1, port: 'bad', secret: 2 } }, registry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as ConfigError).message;
      // All three fields reported in one error
      expect(msg).toContain('3 error');
    }
  });

  it('error message includes offending field paths', () => {
    const registry = makeRegistry([{ key: 'db', schema: z.object({ host: z.string() }) }]);
    try {
      validateConfig({ db: { host: 123 } }, registry);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as ConfigError).message).toContain('db.host');
    }
  });

  it('rejects unknown top-level key not in registry', () => {
    const registry = makeRegistry([{ key: 'db', schema: z.object({ host: z.string() }) }]);
    expect(() => validateConfig({ db: { host: 'localhost' }, orphan: 'value' }, registry)).toThrow(
      ConfigError,
    );
  });

  it('details.issues contains all individual issue strings', () => {
    const registry = makeRegistry([
      { key: 'svc', schema: z.object({ a: z.string(), b: z.number() }) },
    ]);
    try {
      validateConfig({ svc: { a: 1, b: 'bad' } }, registry);
      expect.fail('should have thrown');
    } catch (err) {
      const details = (err as ConfigError).details as { issues: string[] };
      expect(Array.isArray(details.issues)).toBe(true);
      expect(details.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
