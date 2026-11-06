/**
 * Parses JSON text that must hold an object, such as the form schema files in
 * `config/schemas/`, and reads unknown values as objects (web app).
 */

import type { RJSFSchema } from '@rjsf/utils';
import { z } from 'zod';

const JsonObjectSchema = z.record(z.unknown());

/**
 * Whether a value is a plain object (not `null`, not an array).
 *
 * @param value - Any value.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a value as a plain object.
 *
 * @param value - Any value.
 * @returns The value when it is a plain object, else an empty object.
 */
export function jsonObjectOr(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {};
}

/**
 * The top-level properties of a JSON Schema whose definition is an object.
 * Boolean definitions are left out; they carry no keywords to read.
 *
 * @param schema - A JSON Schema.
 * @returns The properties by name; empty when the schema has none.
 */
export function schemaProperties(schema: RJSFSchema): Record<string, RJSFSchema> {
  const out: Record<string, RJSFSchema> = {};
  for (const [name, definition] of Object.entries(jsonObjectOr(schema.properties))) {
    if (isJsonObject(definition)) out[name] = definition;
  }
  return out;
}

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
 * Reads a parsed value as a JSON object.
 *
 * @param value - The parsed value.
 * @returns The object, or `null` when the value is not an object.
 */
export function readJsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = JsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
  const object = readJsonObject(value);
  return object && isJsonSchema(object) ? object : null;
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
