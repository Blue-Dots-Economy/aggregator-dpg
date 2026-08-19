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
import { aggregatorSchemaRelPaths } from '@aggregator-dpg/network-config/paths';
import { getNetworkConfig } from './network-config.js';

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
 *
 * Patches `properties.type.enum` with the live network's domain ids
 * (sourced from network-config / signalstack network.json) before
 * compiling, so the validator accepts whatever domains the current
 * network declares — not the hardcoded `[seeker, provider]` from
 * the schema file.
 */
export async function getRegistrationValidator(): Promise<ValidateFunction> {
  if (cachedValidator) return cachedValidator;
  const schemaPath = resolveSchemaPath();
  const raw = readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw) as Record<string, unknown>;

  try {
    const cfg = await getNetworkConfig();
    const ids = cfg.domainIds;
    if (ids.length > 0) {
      const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
      if (props?.['type']) {
        props['type']['enum'] = ids;
      }
    }
  } catch {
    // Fall back to the schema file's static enum if network-config
    // is unavailable — keeps the registration path open on cold boot.
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
 * Each `config/` root is crossed with {@link aggregatorSchemaRelPaths}, so an
 * instance that needs extra registration fields (UP-GZB captures organisation
 * type / sub-type / management type and a `service_provider` aggregator type)
 * ships its own complete copy under
 * `config/<network>[/<brand>]/schemas/aggregator/` without changing what Purple
 * Dot or Dharwad validate against.
 *
 * @returns Absolute path to the most specific schema file that exists.
 * @throws {Error} If no candidate is readable.
 */
function resolveSchemaPath(): string {
  const roots = [
    // Source layout: apps/api/src/services → ../../../../config
    path.resolve(__dirname, '../../../../config'),
    // Compiled layout: apps/api/dist/services
    path.resolve(__dirname, '../../../../../config'),
    // Container layout when only `config/` is mounted at /app/config
    path.resolve(process.cwd(), 'config'),
    path.resolve(process.cwd(), '../../config'),
  ];
  const rel = aggregatorSchemaRelPaths('registration.v1.json');
  // Specificity first, then root: a brand override in ANY resolvable root must
  // beat the shared default, or a layout where two roots both resolve would
  // silently fall back to the generic schema.
  const candidates = rel.flatMap((r) => roots.map((root) => path.join(root, r)));
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
