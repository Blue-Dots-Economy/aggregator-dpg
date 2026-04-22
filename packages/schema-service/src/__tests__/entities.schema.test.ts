import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import {
  EntityConfigSchema,
  EntitiesConfigSchema,
  type EntityConfig,
  type EntitiesConfig,
} from '../entities.schema.js';

const ENTITIES_YAML = join(import.meta.dirname, '../../../../config/entities.yaml');

describe('EntityConfigSchema', () => {
  it('validates a seeker entity', () => {
    const result = EntityConfigSchema.safeParse({
      type: 'seeker',
      label: 'Job Seeker',
      sections: ['whoIAm', 'whatIWant'],
    });
    expect(result.success).toBe(true);
  });

  it('validates a provider entity', () => {
    const result = EntityConfigSchema.safeParse({
      type: 'provider',
      label: 'Job Provider',
      sections: ['whoIAm', 'whatIHave'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an arbitrary future entity type string', () => {
    const result = EntityConfigSchema.safeParse({
      type: 'verifier',
      label: 'Credential Verifier',
      sections: ['whoIAm'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty type string', () => {
    const result = EntityConfigSchema.safeParse({
      type: '',
      label: 'Empty',
      sections: ['whoIAm'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty sections array', () => {
    const result = EntityConfigSchema.safeParse({
      type: 'seeker',
      label: 'Seeker',
      sections: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown profile group in sections', () => {
    const result = EntityConfigSchema.safeParse({
      type: 'seeker',
      label: 'Seeker',
      sections: ['whoIAm', 'unknownGroup'],
    });
    expect(result.success).toBe(false);
  });
});

describe('EntitiesConfigSchema', () => {
  it('validates a config with multiple entities', () => {
    const result = EntitiesConfigSchema.safeParse({
      entities: [
        { type: 'seeker', label: 'Seeker', sections: ['whoIAm', 'whatIWant'] },
        { type: 'provider', label: 'Provider', sections: ['whoIAm', 'whatIHave'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty entities array', () => {
    const result = EntitiesConfigSchema.safeParse({ entities: [] });
    expect(result.success).toBe(false);
  });
});

describe('TypeScript types', () => {
  it('EntityConfig type is assignable', () => {
    const e: EntityConfig = {
      type: 'seeker',
      label: 'Seeker',
      sections: ['whoIAm'],
    };
    expect(e.type).toBe('seeker');
  });

  it('EntitiesConfig type is assignable', () => {
    const config: EntitiesConfig = {
      entities: [{ type: 'seeker', label: 'Seeker', sections: ['whoIAm'] }],
    };
    expect(config.entities).toHaveLength(1);
  });
});

describe('config/entities.yaml', () => {
  it('parses without error', () => {
    const raw = readFileSync(ENTITIES_YAML, 'utf8');
    expect(() => parseYaml(raw)).not.toThrow();
  });

  it('passes EntitiesConfigSchema validation', () => {
    const raw = readFileSync(ENTITIES_YAML, 'utf8');
    const parsed = parseYaml(raw);
    const result = EntitiesConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('contains seeker and provider entity types', () => {
    const raw = readFileSync(ENTITIES_YAML, 'utf8');
    const parsed = parseYaml(raw) as EntitiesConfig;
    const types = parsed.entities.map((e) => e.type);
    expect(types).toContain('seeker');
    expect(types).toContain('provider');
  });

  it('seeker uses whoIAm and whatIWant sections', () => {
    const raw = readFileSync(ENTITIES_YAML, 'utf8');
    const parsed = parseYaml(raw) as EntitiesConfig;
    const seeker = parsed.entities.find((e) => e.type === 'seeker')!;
    expect(seeker.sections).toContain('whoIAm');
    expect(seeker.sections).toContain('whatIWant');
  });

  it('provider uses whoIAm and whatIHave sections', () => {
    const raw = readFileSync(ENTITIES_YAML, 'utf8');
    const parsed = parseYaml(raw) as EntitiesConfig;
    const provider = parsed.entities.find((e) => e.type === 'provider')!;
    expect(provider.sections).toContain('whoIAm');
    expect(provider.sections).toContain('whatIHave');
  });
});
