/**
 * Compiled Ajv validator for coordinator registration (`@aggregator-dpg/api`).
 *
 * The schema is `config/schemas/aggregator/registration.v1.json`, so the form
 * can change without code changes.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { getNetworkConfig } from './network-config.js';
import { resolveSchema, schemaCandidates } from './schema-ref.js';

const require = createRequire(import.meta.url);
// ajv and ajv-formats are CommonJS; load their default exports through createRequire.
type AjvOptions = { allErrors?: boolean; strict?: boolean | 'log' };
type AjvLike = {
  compile(schema: unknown): ValidateFunction;
};
type AjvCtorType = new (opts?: AjvOptions) => AjvLike;
type AddFormatsFn = (ajv: AjvLike, opts?: unknown) => AjvLike;

// The registration schema uses draft 2020-12, which needs the 2020 Ajv build.
const AjvCtor: AjvCtorType = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats: AddFormatsFn = require('ajv-formats').default ?? require('ajv-formats');

/** The coordinator-registration schema this validator compiles. */
const SCHEMA_FILE = 'registration.v1.json';

let cachedValidator: ValidateFunction | null = null;

/**
 * Returns the shared compiled validator, cached on first use.
 *
 * Before compiling, replaces `properties.type` so it accepts one domain id or a
 * non-empty list without repeats, drawn from the current network's domain ids.
 * Falls back to the schema file's own ids when network config is unavailable.
 */
export async function getRegistrationValidator(): Promise<ValidateFunction> {
  if (cachedValidator) return cachedValidator;
  const schemaPath = resolveSchemaPath();
  const raw = readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as Record<string, unknown>;

  let networkIds: string[] = [];
  try {
    networkIds = (await getNetworkConfig()).domainIds;
  } catch {
    // Keep the schema file's ids if network config is unavailable.
  }
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  const typeProp = props?.['type'];
  if (props && typeProp) {
    props['type'] = oneOrListOf(networkIds.length > 0 ? networkIds : fileDomainIds(typeProp));
  }

  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator: ValidateFunction = ajv.compile(schema);
  cachedValidator = validator;
  return validator;
}

/**
 * Locates `registration.v1.json`, preferring a network/brand override.
 *
 * A network or brand can ship its own copy under
 * `config/<network>[/<brand>]/schemas/aggregator/`. Uses {@link resolveSchema},
 * so the validator and the recorded `profile_ref` pick the same file.
 *
 * @returns Absolute path to the most specific schema file that exists.
 * @throws {Error} If no candidate is readable.
 */
function resolveSchemaPath(): string {
  const resolved = resolveSchema(SCHEMA_FILE);
  if (!resolved) {
    throw new Error(
      `registration schema not found; tried: ${schemaCandidates(SCHEMA_FILE)
        .map((c) => c.path)
        .join(', ')}`,
    );
  }
  return resolved.path;
}

/**
 * Test-only; clears the cached validator so the next call recompiles.
 */
export function _resetValidator(): void {
  cachedValidator = null;
}

/**
 * The domain ids a schema file's `type` property declares, if any.
 *
 * @param typeProp - The file's `properties.type`, a string or array field.
 * @returns The ids from `enum` or `items.enum`; `undefined` when neither is set.
 */
function fileDomainIds(typeProp: Record<string, unknown>): string[] | undefined {
  const items = typeProp['items'] as Record<string, unknown> | undefined;
  const ids = typeProp['enum'] ?? items?.['enum'];
  return Array.isArray(ids) ? (ids as string[]) : undefined;
}

/**
 * A JSON Schema for one domain id or a non-empty list without repeats.
 *
 * The form sends a string or a list depending on the deployment's schema copy,
 * so the API accepts both.
 *
 * @param ids - The allowed ids; `undefined` allows any non-empty string.
 * @returns The schema for `properties.type`.
 */
function oneOrListOf(ids: string[] | undefined): Record<string, unknown> {
  const one: Record<string, unknown> = { type: 'string', minLength: 1 };
  if (ids) one['enum'] = ids;
  return {
    anyOf: [one, { type: 'array', minItems: 1, uniqueItems: true, items: one }],
  };
}
