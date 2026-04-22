import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import {
  FeaturesConfigSchema,
  FeatureFlagsSchema,
  LocaleConfigSchema,
  configDefaults,
  type FeaturesConfig,
} from '../features.schema.js';

const FEATURES_YAML = join(import.meta.dirname, '../../../../config/features.yaml');

describe('FeatureFlagsSchema', () => {
  it('validates all boolean flags present', () => {
    const result = FeatureFlagsSchema.safeParse({
      bulkOnboarding: true,
      qrOnboarding: true,
      linkOnboarding: true,
      betaProfileCompletion: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean flag value', () => {
    const result = FeatureFlagsSchema.safeParse({
      bulkOnboarding: 'yes',
      qrOnboarding: true,
      linkOnboarding: true,
      betaProfileCompletion: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing flag', () => {
    const result = FeatureFlagsSchema.safeParse({
      bulkOnboarding: true,
      qrOnboarding: true,
      linkOnboarding: true,
      // betaProfileCompletion missing
    });
    expect(result.success).toBe(false);
  });
});

describe('LocaleConfigSchema', () => {
  it('validates valid locale config', () => {
    const result = LocaleConfigSchema.safeParse({
      default: 'en',
      available: ['en', 'hi'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty available list', () => {
    const result = LocaleConfigSchema.safeParse({
      default: 'en',
      available: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects single-char locale tag', () => {
    const result = LocaleConfigSchema.safeParse({
      default: 'e',
      available: ['e'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing default', () => {
    const result = LocaleConfigSchema.safeParse({
      available: ['en'],
    });
    expect(result.success).toBe(false);
  });
});

describe('FeaturesConfigSchema', () => {
  it('validates a complete valid config', () => {
    const result = FeaturesConfigSchema.safeParse({
      flags: {
        bulkOnboarding: true,
        qrOnboarding: false,
        linkOnboarding: true,
        betaProfileCompletion: false,
      },
      locale: {
        default: 'en',
        available: ['en', 'hi'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing flags key', () => {
    const result = FeaturesConfigSchema.safeParse({
      locale: { default: 'en', available: ['en'] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing locale key', () => {
    const result = FeaturesConfigSchema.safeParse({
      flags: {
        bulkOnboarding: true,
        qrOnboarding: true,
        linkOnboarding: true,
        betaProfileCompletion: false,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('configDefaults', () => {
  it('passes FeaturesConfigSchema validation', () => {
    const result = FeaturesConfigSchema.safeParse(configDefaults);
    expect(result.success).toBe(true);
  });

  it('betaProfileCompletion defaults to false', () => {
    expect(configDefaults.flags.betaProfileCompletion).toBe(false);
  });

  it('default locale is en', () => {
    expect(configDefaults.locale.default).toBe('en');
  });

  it('available locales includes en, hi, kn, te, ta', () => {
    expect(configDefaults.locale.available).toEqual(
      expect.arrayContaining(['en', 'hi', 'kn', 'te', 'ta']),
    );
  });
});

describe('config/features.yaml', () => {
  it('parses without error', () => {
    const raw = readFileSync(FEATURES_YAML, 'utf8');
    expect(() => parseYaml(raw)).not.toThrow();
  });

  it('passes FeaturesConfigSchema validation', () => {
    const raw = readFileSync(FEATURES_YAML, 'utf8');
    const parsed = parseYaml(raw);
    const result = FeaturesConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('flags and locale keys present', () => {
    const raw = readFileSync(FEATURES_YAML, 'utf8');
    const parsed = parseYaml(raw) as FeaturesConfig;
    expect(parsed.flags).toBeDefined();
    expect(parsed.locale).toBeDefined();
  });

  it('all four flags present', () => {
    const raw = readFileSync(FEATURES_YAML, 'utf8');
    const parsed = parseYaml(raw) as FeaturesConfig;
    expect(parsed.flags.bulkOnboarding).toBeDefined();
    expect(parsed.flags.qrOnboarding).toBeDefined();
    expect(parsed.flags.linkOnboarding).toBeDefined();
    expect(parsed.flags.betaProfileCompletion).toBeDefined();
  });

  it('default locale is en', () => {
    const raw = readFileSync(FEATURES_YAML, 'utf8');
    const parsed = parseYaml(raw) as FeaturesConfig;
    expect(parsed.locale.default).toBe('en');
  });

  it('available has at least 5 locales', () => {
    const raw = readFileSync(FEATURES_YAML, 'utf8');
    const parsed = parseYaml(raw) as FeaturesConfig;
    expect(parsed.locale.available.length).toBeGreaterThanOrEqual(5);
  });
});
