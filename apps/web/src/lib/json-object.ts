/**
 * Parses JSON text that must hold an object, such as the form schema files in
 * `config/schemas/` (web app).
 */

import type { RJSFSchema } from '@rjsf/utils';
import { z } from 'zod';

const JsonObjectSchema = z.record(z.unknown());

/**
 * Parses JSON text that holds an object.
 *
 * @param text - The JSON text.
 * @returns The object.
 * @throws {SyntaxError} When the text is not JSON.
 * @throws {Error} When the JSON value is not an object.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JsonObjectSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('expected a JSON object');
  return parsed.data;
}

/**
 * The JSON Schema keywords this app reads from a form schema file: `type` and
 * `properties`. Other keywords are left to RJSF.
 */
const JsonSchemaKeywordsSchema = z.object({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  properties: z.record(z.unknown()).optional(),
});

/** Narrows a JSON object to a JSON Schema once its `type` and `properties` have the right form. */
function isJsonSchema(value: Record<string, unknown>): value is RJSFSchema {
  return JsonSchemaKeywordsSchema.safeParse(value).success;
}

/**
 * Reads a parsed value as a JSON Schema for an RJSF form.
 *
 * @param value - The parsed value, for example a `schema` field of an API response.
 * @returns The schema, or `null` when the value is not an object or its `type` or `properties` has the wrong form.
 */
export function readJsonSchema(value: unknown): RJSFSchema | null {
  const parsed = JsonObjectSchema.safeParse(value);
  if (!parsed.success || !isJsonSchema(parsed.data)) return null;
  return parsed.data;
}

/**
 * Parses JSON text that holds a JSON Schema for an RJSF form.
 *
 * @param text - The JSON text.
 * @returns The schema.
 * @throws {SyntaxError} When the text is not JSON.
 * @throws {Error} When the JSON value is not an object, or its `type` or `properties` has the wrong form.
 */
export function parseJsonSchema(text: string): RJSFSchema {
  const value = parseJsonObject(text);
  if (!isJsonSchema(value)) throw new Error('expected a JSON Schema object');
  return value;
}
