import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import {
  ProfilesConfigSchema,
  ProfileFieldSchema,
  configDefaults,
  configKey,
} from '../config.schema.js';

// Path from packages/schema-service to repo root config/
const PROFILES_YAML = join(import.meta.dirname, '../../../../config/profiles.yaml');

describe('configKey', () => {
  it('is "profiles"', () => {
    expect(configKey).toBe('profiles');
  });
});

describe('ProfileFieldSchema', () => {
  it('validates a text field without options', () => {
    const result = ProfileFieldSchema.safeParse({
      name: 'representativeName',
      label: 'Name of accountable representative',
      type: 'text',
      required: true,
      group: 'whoIAm',
    });
    expect(result.success).toBe(true);
  });

  it('validates a select field with options', () => {
    const result = ProfileFieldSchema.safeParse({
      name: 'contactPreference',
      label: 'Contact preference',
      type: 'select',
      required: true,
      group: 'whatIWant',
      options: ['direct', 'viaAggregator'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown field type', () => {
    const result = ProfileFieldSchema.safeParse({
      name: 'x',
      label: 'x',
      type: 'checkbox',
      required: false,
      group: 'whoIAm',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown group', () => {
    const result = ProfileFieldSchema.safeParse({
      name: 'x',
      label: 'x',
      type: 'text',
      required: false,
      group: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = ProfileFieldSchema.safeParse({
      name: '',
      label: 'x',
      type: 'text',
      required: false,
      group: 'whoIAm',
    });
    expect(result.success).toBe(false);
  });
});

describe('ProfilesConfigSchema', () => {
  it('validates a minimal valid config', () => {
    const result = ProfilesConfigSchema.safeParse({
      completeness: { threshold: 0.75 },
      fields: [
        {
          name: 'email',
          label: 'Email',
          type: 'email',
          required: true,
          group: 'whoIAm',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects threshold > 1', () => {
    const result = ProfilesConfigSchema.safeParse({
      completeness: { threshold: 1.5 },
      fields: [{ name: 'x', label: 'x', type: 'text', required: true, group: 'whoIAm' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty fields array', () => {
    const result = ProfilesConfigSchema.safeParse({
      completeness: { threshold: 0.75 },
      fields: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('configDefaults', () => {
  it('passes ProfilesConfigSchema validation', () => {
    const result = ProfilesConfigSchema.safeParse(configDefaults);
    expect(result.success).toBe(true);
  });

  it('has threshold 0.75', () => {
    expect(configDefaults.completeness.threshold).toBe(0.75);
  });

  it('has fields in all three groups', () => {
    const groups = new Set(configDefaults.fields.map((f) => f.group));
    expect(groups.has('whoIAm')).toBe(true);
    expect(groups.has('whatIWant')).toBe(true);
    expect(groups.has('whatIHave')).toBe(true);
  });

  it('all select/multiselect fields have options', () => {
    const selectFields = configDefaults.fields.filter(
      (f) => f.type === 'select' || f.type === 'multiselect',
    );
    for (const field of selectFields) {
      expect(field.options).toBeDefined();
      expect(field.options!.length).toBeGreaterThan(0);
    }
  });
});

describe('config/profiles.yaml', () => {
  it('parses without error', () => {
    const raw = readFileSync(PROFILES_YAML, 'utf8');
    expect(() => parseYaml(raw)).not.toThrow();
  });

  it('passes ProfilesConfigSchema validation', () => {
    const raw = readFileSync(PROFILES_YAML, 'utf8');
    const parsed = parseYaml(raw);
    const result = ProfilesConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('has the same threshold as configDefaults', () => {
    const raw = readFileSync(PROFILES_YAML, 'utf8');
    const parsed = parseYaml(raw) as { completeness: { threshold: number } };
    expect(parsed.completeness.threshold).toBe(configDefaults.completeness.threshold);
  });
});
