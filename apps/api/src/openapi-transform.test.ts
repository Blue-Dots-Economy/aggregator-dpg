import { beforeEach, describe, expect, it, vi } from 'vitest';

const generated = vi.hoisted(() => ({ schema: {} as unknown }));

vi.mock('fastify-type-provider-zod', () => ({
  jsonSchemaTransform: () => ({ schema: generated.schema, url: '/x' }),
}));

import { openApiTransform } from './openapi-transform.js';

function run(schema: unknown): Record<string, unknown> {
  generated.schema = schema;
  return openApiTransform({ schema: {}, url: '/x' }).schema as Record<string, unknown>;
}

describe('openApiTransform', () => {
  beforeEach(() => {
    generated.schema = {};
  });

  it('flags a field whose description starts with Deprecated', () => {
    const out = run({
      properties: { old: { type: 'string', description: 'Deprecated: use new.' } },
    });
    expect(out).toMatchObject({ properties: { old: { deprecated: true } } });
  });

  it('leaves other descriptions alone', () => {
    const out = run({ properties: { ok: { type: 'string', description: 'Current field.' } } });
    expect(JSON.stringify(out)).not.toContain('deprecated');
  });

  it('walks nested object properties and array items', () => {
    const out = run({
      properties: {
        nested: { properties: { old: { description: 'Deprecated: gone.' } } },
        list: { type: 'array', items: { description: 'Deprecated: gone.' } },
      },
    });
    expect(out).toMatchObject({
      properties: {
        nested: { properties: { old: { deprecated: true } } },
        list: { items: { deprecated: true } },
      },
    });
  });

  it('walks arrays such as anyOf branches', () => {
    const out = run({ anyOf: [{ description: 'Deprecated: gone.' }, { type: 'null' }] });
    expect(out).toMatchObject({ anyOf: [{ deprecated: true }, { type: 'null' }] });
  });

  it('does not alter example, examples or default data', () => {
    const out = run({
      properties: {
        field: {
          type: 'object',
          example: { description: 'Deprecated example' },
          examples: [{ description: 'Deprecated example' }],
          default: { description: 'Deprecated default' },
        },
      },
    });
    expect(JSON.stringify(out)).not.toContain('deprecated');
  });
});
