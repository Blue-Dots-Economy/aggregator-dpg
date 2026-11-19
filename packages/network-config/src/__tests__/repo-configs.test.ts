import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AggregatorYamlSchema } from '../interface.js';

const CONFIG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../config',
);

function findConfigs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return findConfigs(full);
    return name === 'aggregator.config.yaml' || name === 'aggregator.config.example.yaml'
      ? [full]
      : [];
  });
}

const configs = findConfigs(CONFIG_ROOT);

describe('repo aggregator configs', () => {
  it('finds the shipped configs', () => {
    expect(configs.length).toBeGreaterThan(0);
  });

  describe.each(configs.map((f) => [path.relative(CONFIG_ROOT, f), f]))('%s', (_rel, file) => {
    const raw = parse(readFileSync(file as string, 'utf8'));

    it('parses against AggregatorYamlSchema', () => {
      expect(AggregatorYamlSchema.safeParse(raw).success).toBe(true);
    });

    it('declares voice_or_form offering voice and form whenever it declares voice', () => {
      const modes = AggregatorYamlSchema.parse(raw).aggregator.registration_modes;
      if (!('voice' in modes)) return;
      expect(modes.voice_or_form?.offers).toEqual(['voice', 'form']);
    });
  });
});
