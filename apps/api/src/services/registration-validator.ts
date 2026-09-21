/**
 * Compiles the Ajv validator for coordinator registration from the published
 * form bundle on the mounted config tree.
 *
 * Before #640 this read `registration.v1.json` from the copy baked into the
 * image. That copy is gone: the forms are published in `bluedots-schemas` as
 * `aggregator-forms.json`, and the initContainer mounts that tree over
 * `/app/config` — which is also why the baked copy was unreachable in the
 * deployment that needed it.
 *
 * Nothing is baked in as a fallback. When the mount carries no bundle this
 * returns `null` and the route answers `503 SCHEMA_UNAVAILABLE` — accepting a
 * registration we cannot validate would defeat the `additionalProperties:
 * false` allowlist that keeps unknown fields out of the participant record.
 *
 * @module apps/api/services/registration-validator
 */

import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { getNetworkConfig } from './network-config.js';
import { getPublishedForm } from './aggregator-forms.js';

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

/** The published form this validator compiles. */
const FORM_NAME = 'coordinator-registration' as const;

let cachedValidator: ValidateFunction | null = null;

/**
 * Returns the shared compiled validator, or `null` when the published bundle
 * carries no coordinator-registration form.
 *
 * Patches `properties.type.enum` with the live network's domain ids before
 * compiling, so the validator accepts whatever domains the current network
 * declares rather than the enum frozen into the published document.
 *
 * Only a successful compile is cached — a `null` must stay retryable, or an
 * instance that raced its first request against config resolution would answer
 * 503 for the life of the process.
 *
 * @returns The compiled validator, or `null` when no schema is available.
 */
export async function getRegistrationValidator(): Promise<ValidateFunction | null> {
  if (cachedValidator) return cachedValidator;
  const form = getPublishedForm(FORM_NAME);
  if (!form) return null;

  // Clone before patching: the parsed bundle is cached process-wide, and
  // mutating it here would leak a network-specific enum into every other
  // reader of the same object.
  const schema = structuredClone(form.schema);

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
    // Fall back to the published document's static enum if network-config
    // is unavailable — keeps the registration path open on cold boot.
  }

  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator: ValidateFunction = ajv.compile(schema);
  cachedValidator = validator;
  return validator;
}

/**
 * Test-only — clears the cached validator so a fresh compile happens on
 * the next call (e.g. after the published bundle changes).
 */
export function _resetValidator(): void {
  cachedValidator = null;
}
