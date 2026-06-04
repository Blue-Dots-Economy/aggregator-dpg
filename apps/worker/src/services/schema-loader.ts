/**
 * Worker schema loader singleton.
 *
 * Hybrid resolution mirrors `apps/api/src/services/schema-loader/index.ts`:
 *   - `participant-{domain}`  → resolved from the in-memory network-config
 *     (signalstack `network.json`'s `domains[<domain>].item_schemas`).
 *     No local copy of seeker / provider JSON Schemas lives on the
 *     aggregator side — signals-dpg is the single source of truth.
 *   - any other id            → falls back to the file-based loader
 *     under `config/<network>/schemas/`.
 *
 * Compiled Ajv validators are cached per (schema_id, version) for the
 * lifetime of the process.
 */

import { createRequire } from 'node:module';
import { ok, err, type Result } from '@aggregator-dpg/shared-primitives/result';
import { type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  SchemaLoaderBase,
  SchemaNotFoundError,
  SchemaCompileError,
  type JsonSchema,
  type SchemaRef,
  type ValidateFunction,
} from '@aggregator-dpg/schema-loader/interface';
import { FileSchemaLoader } from '@aggregator-dpg/schema-loader/file';
import { config } from '../config.js';
import { getNetworkConfig } from './network-config.js';

const require = createRequire(import.meta.url);
type AjvOptions = {
  allErrors?: boolean;
  strict?: boolean | 'log';
  coerceTypes?: boolean | 'array';
};
type AjvLike = { compile(schema: unknown): ValidateFunction };
type AjvCtorType = new (opts?: AjvOptions) => AjvLike;
type AddFormatsFn = (ajv: AjvLike, opts?: unknown) => AjvLike;

const AjvCtor: AjvCtorType = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
const addFormats: AddFormatsFn = require('ajv-formats').default ?? require('ajv-formats');

class NetworkSchemaLoader extends SchemaLoaderBase {
  private readonly file: FileSchemaLoader;
  private readonly ajv: AjvLike;
  private readonly validatorCache = new Map<string, ValidateFunction>();

  constructor(rootDir: string) {
    super();
    this.file = new FileSchemaLoader({ rootDir });
    this.ajv = new AjvCtor({ allErrors: true, strict: false, coerceTypes: 'array' });
    addFormats(this.ajv);
  }

  async getSchema(ref: SchemaRef): Promise<Result<JsonSchema, BaseError>> {
    const domain = participantDomain(ref);
    if (domain === null) return this.file.getSchema(ref);

    const cfg = await getNetworkConfig();
    const resolved = cfg.domains[domain];
    if (!resolved) return err(new SchemaNotFoundError(ref));
    return ok(resolved.schema as JsonSchema);
  }

  async getValidator(ref: SchemaRef): Promise<Result<ValidateFunction, BaseError>> {
    const domain = participantDomain(ref);
    if (domain === null) return this.file.getValidator(ref);

    const cacheKey = `${ref.id}:${ref.version}`;
    const cached = this.validatorCache.get(cacheKey);
    if (cached) return ok(cached);

    const schemaResult = await this.getSchema(ref);
    if (!schemaResult.success) return err(schemaResult.error);
    try {
      const validate = this.ajv.compile(schemaResult.value);
      this.validatorCache.set(cacheKey, validate);
      return ok(validate);
    } catch (cause) {
      return err(new SchemaCompileError(ref, cause));
    }
  }
}

function participantDomain(ref: SchemaRef): string | null {
  if (!ref.id.startsWith('participant-')) return null;
  const domain = ref.id.slice('participant-'.length);
  if (!/^[a-z0-9_]+$/i.test(domain)) return null;
  return domain;
}

let instance: NetworkSchemaLoader | null = null;

export function getSchemaLoader(): NetworkSchemaLoader {
  if (instance) return instance;
  instance = new NetworkSchemaLoader(config.SCHEMA_ROOT_DIR);
  return instance;
}
