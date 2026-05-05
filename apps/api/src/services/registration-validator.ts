/**
 * Loads the published JSON Schema for aggregator registration and returns a
 * compiled Ajv validator. Schema lives at
 * `config/schemas/aggregator/registration.v1.json` so non-engineers can
 * change the form without touching code.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';

const require = createRequire(import.meta.url);
// CJS interop — ajv 8 and ajv-formats publish CommonJS modules. Default
// imports under NodeNext + ESM resolve to the namespace object, so we
// fetch the constructible default export through createRequire.
type AjvOptions = { allErrors?: boolean; strict?: boolean | 'log' };
type AjvLike = {
  compile(schema: unknown): ValidateFunction;
};
type AjvCtorType = new (opts?: AjvOptions) => AjvLike;
type AddFormatsFn = (ajv: AjvLike, opts?: unknown) => AjvLike;

// Use the 2020-12 Ajv build because the registration schema declares
// `"$schema": "https://json-schema.org/draft/2020-12/schema"`. The default
// Ajv export only knows about draft-07 / 2019-09 meta-schemas.
const AjvCtor: AjvCtorType = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats: AddFormatsFn = require('ajv-formats').default ?? require('ajv-formats');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedValidator: ValidateFunction | null = null;

/**
 * Returns the shared compiled validator. Caches on first use.
 */
export function getRegistrationValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const schemaPath = resolveSchemaPath();
  const raw = readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as Record<string, unknown>;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator: ValidateFunction = ajv.compile(schema);
  cachedValidator = validator;
  return validator;
}

function resolveSchemaPath(): string {
  const candidates = [
    // Source layout: apps/api/src/services → ../../../config
    path.resolve(__dirname, '../../../../config/schemas/aggregator/registration.v1.json'),
    // Compiled layout: apps/api/dist/services
    path.resolve(__dirname, '../../../../../config/schemas/aggregator/registration.v1.json'),
    // Container layout when only `config/` is mounted at /app/config
    path.resolve(process.cwd(), 'config/schemas/aggregator/registration.v1.json'),
    path.resolve(process.cwd(), '../../config/schemas/aggregator/registration.v1.json'),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf8');
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(`registration schema not found; tried: ${candidates.join(', ')}`);
}

/**
 * Test-only — clears the cached validator so a fresh compile happens on
 * the next call (e.g. after the schema file changes).
 */
export function _resetValidator(): void {
  cachedValidator = null;
}
