import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import {
  OnboardingConfigSchema,
  BulkModeSchema,
  QrModeSchema,
  LinkModeSchema,
  type OnboardingConfig,
} from '../onboarding.schema.js';

const ONBOARDING_YAML = join(import.meta.dirname, '../../../../config/onboarding.yaml');

describe('BulkModeSchema', () => {
  it('validates enabled bulk mode with csvTemplate', () => {
    const result = BulkModeSchema.safeParse({ enabled: true, csvTemplate: 'config/bulk.csv' });
    expect(result.success).toBe(true);
  });

  it('validates disabled bulk mode', () => {
    const result = BulkModeSchema.safeParse({ enabled: false, csvTemplate: 'config/bulk.csv' });
    expect(result.success).toBe(true);
  });

  it('rejects empty csvTemplate', () => {
    const result = BulkModeSchema.safeParse({ enabled: true, csvTemplate: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing csvTemplate', () => {
    const result = BulkModeSchema.safeParse({ enabled: true });
    expect(result.success).toBe(false);
  });
});

describe('QrModeSchema', () => {
  it('validates with positive integer size', () => {
    const result = QrModeSchema.safeParse({ enabled: true, size: 256 });
    expect(result.success).toBe(true);
  });

  it('rejects zero size', () => {
    const result = QrModeSchema.safeParse({ enabled: true, size: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer size', () => {
    const result = QrModeSchema.safeParse({ enabled: true, size: 256.5 });
    expect(result.success).toBe(false);
  });
});

describe('LinkModeSchema', () => {
  it('validates with positive integer ttlSeconds', () => {
    const result = LinkModeSchema.safeParse({ enabled: true, ttlSeconds: 86400 });
    expect(result.success).toBe(true);
  });

  it('rejects zero ttlSeconds', () => {
    const result = LinkModeSchema.safeParse({ enabled: true, ttlSeconds: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative ttlSeconds', () => {
    const result = LinkModeSchema.safeParse({ enabled: true, ttlSeconds: -1 });
    expect(result.success).toBe(false);
  });
});

describe('OnboardingConfigSchema', () => {
  it('validates a complete valid config', () => {
    const result = OnboardingConfigSchema.safeParse({
      modes: {
        bulk: { enabled: true, csvTemplate: 'config/bulk.csv' },
        qr: { enabled: true, size: 256 },
        link: { enabled: true, ttlSeconds: 86400 },
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates with all modes disabled', () => {
    const result = OnboardingConfigSchema.safeParse({
      modes: {
        bulk: { enabled: false, csvTemplate: 'config/bulk.csv' },
        qr: { enabled: false, size: 128 },
        link: { enabled: false, ttlSeconds: 3600 },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing modes key', () => {
    const result = OnboardingConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects missing a mode', () => {
    const result = OnboardingConfigSchema.safeParse({
      modes: {
        bulk: { enabled: true, csvTemplate: 'config/bulk.csv' },
        qr: { enabled: true, size: 256 },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('config/onboarding.yaml', () => {
  it('parses without error', () => {
    const raw = readFileSync(ONBOARDING_YAML, 'utf8');
    expect(() => parseYaml(raw)).not.toThrow();
  });

  it('passes OnboardingConfigSchema validation', () => {
    const raw = readFileSync(ONBOARDING_YAML, 'utf8');
    const parsed = parseYaml(raw);
    const result = OnboardingConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('all three modes present', () => {
    const raw = readFileSync(ONBOARDING_YAML, 'utf8');
    const parsed = parseYaml(raw) as OnboardingConfig;
    expect(parsed.modes.bulk).toBeDefined();
    expect(parsed.modes.qr).toBeDefined();
    expect(parsed.modes.link).toBeDefined();
  });

  it('link ttlSeconds is 86400', () => {
    const raw = readFileSync(ONBOARDING_YAML, 'utf8');
    const parsed = parseYaml(raw) as OnboardingConfig;
    expect(parsed.modes.link.ttlSeconds).toBe(86400);
  });

  it('qr size is 256', () => {
    const raw = readFileSync(ONBOARDING_YAML, 'utf8');
    const parsed = parseYaml(raw) as OnboardingConfig;
    expect(parsed.modes.qr.size).toBe(256);
  });
});
