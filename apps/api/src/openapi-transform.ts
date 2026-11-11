import { jsonSchemaTransform } from 'fastify-type-provider-zod';

const DEPRECATED_PREFIX = 'Deprecated';
const EXAMPLE_KEYS = new Set(['example', 'examples', 'default']);

function markDeprecated(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(markDeprecated);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const schema = node as Record<string, unknown>;
  if (typeof schema.description === 'string' && schema.description.startsWith(DEPRECATED_PREFIX)) {
    schema.deprecated = true;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!EXAMPLE_KEYS.has(key)) markDeprecated(value);
  }
}

/** Zod-to-JSON-schema transform that also flags fields described as "Deprecated..." with `deprecated: true`. */
export const openApiTransform: typeof jsonSchemaTransform = (input) => {
  const out = jsonSchemaTransform(input);
  markDeprecated(out.schema);
  return out;
};
