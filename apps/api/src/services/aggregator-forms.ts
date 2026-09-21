/**
 * Resolves the aggregator form schemas from the mounted config tree.
 *
 * Since #640 the forms are published in `bluedots-schemas` as a single
 * `aggregator-forms.json` per scope, at the path this loader already probes
 * (`[<network>[/<brand>]/]schemas/aggregator/`). The K8s initContainer mounts
 * that tree over `/app/config`, so a deployment picks up form changes by
 * bumping the schemas tag and rolling pods — no image rebuild, and the version
 * is pinned by the mount rather than tracking a branch (#512 Part 1).
 *
 * One bundle rather than one file per form: a form has to be a single document
 * to be published as one, and the three keys — `coordinator-registration`,
 * `org-registration`, `profile` — name who fills the form in rather than the
 * code path that loads it.
 *
 * There is no copy baked into this image. A deployment whose mount carries no
 * bundle has no form contract, and the routes that need one answer
 * `503 SCHEMA_UNAVAILABLE` rather than guessing — accepting a registration we
 * cannot validate would bypass the `additionalProperties: false` allowlist that
 * keeps unknown fields out of the participant record.
 *
 * @module apps/api/services/aggregator-forms
 */

import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import { resolveSchema } from './schema-ref.js';
import type { ConfigPathEnv } from '@aggregator-dpg/network-config/paths';

/** The published bundle file name, identical in every scope. */
export const FORMS_BUNDLE_FILE = 'aggregator-forms.json';

/**
 * The forms a bundle publishes.
 *
 * Named for who fills the form in, which is why these are not the old
 * `registration.v1` / `profile.v1` filenames.
 */
export type AggregatorFormName = 'coordinator-registration' | 'org-registration' | 'profile';

/** A form resolved from the mounted bundle, with the ref naming its origin. */
export interface ResolvedForm {
  /** The JSON Schema document, as published. */
  schema: Record<string, unknown>;
  /**
   * Provenance recorded on the row this form produced, e.g.
   * `blue_dot/up-gzb/coordinator-registration`.
   */
  ref: string;
}

/** Parsed bundle + the scope of the file that answered. */
interface LoadedBundle {
  forms: Record<string, unknown>;
  /** Scope prefix from the resolved path, e.g. `blue_dot/up-gzb` or ``. */
  scope: string;
}

let cached: LoadedBundle | null = null;

/**
 * Reads and parses the most specific `aggregator-forms.json` on the mount.
 *
 * Never throws: an unreadable or malformed bundle is a deployment fault the
 * caller turns into a 503, not an exception to unwind a request through.
 *
 * Only a successful parse is cached, so an instance that started before its
 * mount was ready recovers on a later request instead of failing for the life
 * of the process.
 *
 * @param env - Env bag selecting network/brand; defaults to `process.env`.
 * @returns The parsed bundle, or `null` when none resolved.
 */
function loadBundle(env: ConfigPathEnv = process.env): LoadedBundle | null {
  if (cached) return cached;

  const resolved = resolveSchema(FORMS_BUNDLE_FILE, env);
  if (!resolved) {
    logger.warn({
      operation: 'aggregatorForms.loadBundle',
      status: 'skipped',
      reason: 'bundle_not_found',
      file: FORMS_BUNDLE_FILE,
    });
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(resolved.path, 'utf8')) as { forms?: unknown };
    if (!parsed.forms || typeof parsed.forms !== 'object') {
      logger.error({
        operation: 'aggregatorForms.loadBundle',
        status: 'failure',
        error: 'bundle has no `forms` object',
        path: resolved.path,
      });
      return null;
    }
    // `ref` here is the scope, not a file ref: strip the trailing form-less
    // name so callers can append the form key they asked for.
    cached = {
      forms: parsed.forms as Record<string, unknown>,
      scope: resolved.ref.replace(/(^|\/)aggregator-forms$/, ''),
    };
    return cached;
  } catch (err) {
    logger.error({
      operation: 'aggregatorForms.loadBundle',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : 'unknown',
      path: resolved.path,
    });
    return null;
  }
}

/**
 * Returns a published form and its ref, or `null` when the mount carries no
 * bundle or the bundle omits that form.
 *
 * `null` rather than a throw: the caller decides whether a missing form is a
 * 503 (registration cannot proceed) or merely an unrecorded ref.
 *
 * @param name - Which form to resolve.
 * @param env - Env bag selecting network/brand; defaults to `process.env`.
 * @returns The schema and its ref, or `null` when unavailable.
 */
export function getPublishedForm(
  name: AggregatorFormName,
  env: ConfigPathEnv = process.env,
): ResolvedForm | null {
  const bundle = loadBundle(env);
  if (!bundle) return null;
  const schema = bundle.forms[name];
  if (!schema || typeof schema !== 'object') {
    logger.warn({
      operation: 'aggregatorForms.getPublishedForm',
      status: 'skipped',
      reason: 'form_absent_from_bundle',
      form: name,
    });
    return null;
  }
  return {
    schema: schema as Record<string, unknown>,
    ref: bundle.scope ? `${bundle.scope}/${name}` : name,
  };
}

/**
 * Returns the `profile_ref` for a published form, or `null` when unavailable.
 *
 * Derived from the bundle that actually answered, never from
 * `AGGREGATOR_NETWORK`/`AGGREGATOR_BRAND`: lookup falls back to the shared
 * default when a brand override is absent, so an env-derived ref would claim
 * `blue_dot/up-gzb/...` for a payload that came from the generic form —
 * mislabelling exactly the drift this column exists to detect.
 *
 * @param name - Which form produced the payload.
 * @param env - Env bag selecting network/brand; defaults to `process.env`.
 * @returns The ref, or `null`.
 */
export function publishedFormRef(
  name: AggregatorFormName,
  env: ConfigPathEnv = process.env,
): string | null {
  return getPublishedForm(name, env)?.ref ?? null;
}

/** Test-only — clears the parsed-bundle cache. */
export function _resetFormsBundle(): void {
  cached = null;
}
