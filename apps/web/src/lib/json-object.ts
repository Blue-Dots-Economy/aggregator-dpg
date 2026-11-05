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

/** Narrows a JSON object to a JSON Schema; RJSF checks the keywords when it renders. */
function isJsonSchema(value: Record<string, unknown>): value is RJSFSchema {
  return !Array.isArray(value);
}

/**
 * Parses JSON text that holds a JSON Schema for an RJSF form.
 *
 * @param text - The JSON text.
 * @returns The schema.
 * @throws {SyntaxError} When the text is not JSON.
 * @throws {Error} When the JSON value is not an object.
 */
export function parseJsonSchema(text: string): RJSFSchema {
  const value = parseJsonObject(text);
  if (!isJsonSchema(value)) throw new Error('expected a JSON object');
  return value;
}
