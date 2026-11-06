/**
 * File-based SchemaLoader. Reads JSON Schema documents from disk under
 * `config/schemas/` and compiles them with Ajv 2020-12.
 *
 * Conventions:
 *   - Schema id format: `{actor}-{action}` (e.g. `participant-seeker`,
 *     `aggregator-registration`).
 *   - File path: `config/schemas/{actor}/{action}.{version}.json` where
 *     version matches `^v\\d+$`.
 *   - Schema documents must declare `$schema: https://json-schema.org/draft/2020-12/schema`.
 *
 * Caching:
 *   - Schemas and validators are cached by `(id, version)` for the loader's
 *     lifetime. Schema files only change on deploy.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ok, err, type Result } from '@aggregator-dpg/shared-primitives/result';
import { type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  SchemaLoaderBase,
  SchemaNotFoundError,
  SchemaCompileError,
  type JsonSchema,
  type SchemaRef,
  type ValidateFunction,
} from './interface.js';
import { createAjv, type AjvLike } from './ajv.js';

export interface FileSchemaLoaderOptions {
  /**
   * Absolute path to the directory holding schema files. Layout is
   * `{rootDir}/{actor}/{action}.v{N}.json`.
   */
  rootDir: string;
}

export class FileSchemaLoader extends SchemaLoaderBase {
  private readonly rootDir: string;
  private readonly schemaCache = new Map<string, JsonSchema>();
  private readonly validatorCache = new Map<string, ValidateFunction>();
  private readonly ajv: AjvLike;

  constructor(opts: FileSchemaLoaderOptions) {
    super();
    this.rootDir = opts.rootDir;
    // coerceTypes 'array' wraps a single string in an array; the worker still
    // splits comma-joined cells before validation.
    this.ajv = createAjv();
  }

  async getSchema(ref: SchemaRef): Promise<Result<JsonSchema, BaseError>> {
    if (!isSafeRef(ref)) {
      return err(new SchemaNotFoundError(ref));
    }
    const cacheKey = `${ref.id}:${ref.version}`;
    const cached = this.schemaCache.get(cacheKey);
    if (cached) return ok(cached);

    const filePath = this.resolvePath(ref);
    if (!isInsideRoot(filePath, this.rootDir)) {
      return err(new SchemaNotFoundError(ref));
    }
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return err(new SchemaNotFoundError(ref));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      return err(new SchemaCompileError(ref, parseErr));
    }
    if (!isJsonSchema(parsed)) {
      return err(new SchemaCompileError(ref, new Error('schema document is not a JSON object')));
    }
    this.schemaCache.set(cacheKey, parsed);
    return ok(parsed);
  }

  async getValidator(ref: SchemaRef): Promise<Result<ValidateFunction, BaseError>> {
    const cacheKey = `${ref.id}:${ref.version}`;
    const cached = this.validatorCache.get(cacheKey);
    if (cached) return ok(cached);

    const schemaResult = await this.getSchema(ref);
    if (!schemaResult.success) return schemaResult;

    try {
      const validator = this.ajv.compile(schemaResult.value);
      this.validatorCache.set(cacheKey, validator);
      return ok(validator);
    } catch (compileErr) {
      return err(new SchemaCompileError(ref, compileErr));
    }
  }

  private resolvePath(ref: SchemaRef): string {
    // "participant-seeker" → actor "participant", action "seeker". No hyphen: id is both.
    const dashIndex = ref.id.indexOf('-');
    const actor = dashIndex === -1 ? ref.id : ref.id.slice(0, dashIndex);
    const action = dashIndex === -1 ? ref.id : ref.id.slice(dashIndex + 1);
    return path.join(this.rootDir, actor, `${action}.${ref.version}.json`);
  }

  /** Test-only — clears caches so a fresh read happens on next call. */
  resetCaches(): void {
    this.schemaCache.clear();
    this.validatorCache.clear();
  }
}

// Allowed identifier shapes for schema id segments + version.
//   id        e.g. participant-seeker, aggregator-registration
//   version   e.g. v1, v2, v10
const SAFE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_VERSION_RE = /^v\d{1,4}$/;

/**
 * Checks that a parsed schema document is a JSON object.
 *
 * @param value - The result of `JSON.parse`.
 * @returns `true` for a non-null, non-array object.
 */
function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRef(ref: SchemaRef): boolean {
  return SAFE_ID_RE.test(ref.id) && SAFE_VERSION_RE.test(ref.version);
}

/** Checks the resolved schema path stays inside the root. Backs up `isSafeRef`. */
function isInsideRoot(filePath: string, rootDir: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(filePath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}
