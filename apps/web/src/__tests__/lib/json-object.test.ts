import { describe, it, expect } from 'vitest';
import { parseJsonObject, parseJsonSchema } from '@/lib/json-object';

describe('parseJsonObject', () => {
  it('returns the object a JSON text holds', () => {
    expect(parseJsonObject('{"ui:order":["name"]}')).toEqual({ 'ui:order': ['name'] });
  });

  it.each([['[1,2]'], ['"text"'], ['null'], ['42']])(
    'throws for %s, which is not an object',
    (text) => {
      expect(() => parseJsonObject(text)).toThrow(/JSON object/);
    },
  );

  it('throws for text that is not JSON', () => {
    expect(() => parseJsonObject('{not json')).toThrow();
  });
});

describe('parseJsonSchema', () => {
  it('returns the schema object', () => {
    const schema = parseJsonSchema('{"type":"object","properties":{"name":{"type":"string"}}}');
    expect(schema.type).toBe('object');
  });

  it('throws when the text is not an object', () => {
    expect(() => parseJsonSchema('[]')).toThrow(/JSON object/);
  });

  it.each([
    ['{"type":5}', 'a numeric type'],
    ['{"properties":[]}', 'properties as a list'],
  ])('throws for %s (%s), which is not a JSON Schema', (text) => {
    expect(() => parseJsonSchema(text)).toThrow(/JSON Schema/);
  });
});
