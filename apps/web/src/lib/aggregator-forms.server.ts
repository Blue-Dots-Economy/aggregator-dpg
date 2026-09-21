/**
 * Reads the aggregator form schemas from the mounted config tree.
 *
 * Since #640 the forms are published in `bluedots-schemas` as a single
 * `aggregator-forms.json` per scope, at the path this app already probes
 * (`[<network>[/<brand>]/]schemas/aggregator/`). The K8s initContainer mounts
 * that tree over `/app/config`, so a form change ships by bumping the schemas
 * tag and rolling pods — no image rebuild, and the version is pinned by the
 * mount rather than tracking a branch.
 *
 * No copy is baked into this image, so `null` means the deployment has no form
 * contract at all. The caller decides what that means for its surface — the
 * registration page has nothing to render, whereas an absent org form just
 * leaves the owner route 404ing, as it always has for instances without the
 * org tab.
 *
 * @module apps/web/src/lib/aggregator-forms.server
 */

import 'server-only';
import { readFile } from 'node:fs/promises';
import { resolveAggregatorSchemaPath } from './aggregator-schema.server';
import { logger } from './logger';

/** The published bundle file name, identical in every scope. */
export const FORMS_BUNDLE_FILE = 'aggregator-forms.json';

/** The forms a bundle publishes, named for who fills each one in. */
export type AggregatorFormName = 'coordinator-registration' | 'org-registration' | 'profile';

/** Parsed bundle, cached for the life of the process. */
let cached: Record<string, unknown> | null = null;

/**
 * Returns a published form schema, or `null` when the mount carries no bundle
 * or the bundle omits that form.
 *
 * Never throws: a missing or malformed bundle is a deployment fault, and the
 * caller turns it into its own user-facing state rather than an unhandled
 * render error.
 *
 * Only a successful parse is cached, so an instance that rendered before its
 * mount was ready recovers on a later request.
 *
 * @param name - Which form to read.
 * @returns The JSON Schema document, or `null` when unavailable.
 */
export async function loadPublishedForm(
  name: AggregatorFormName,
): Promise<Record<string, unknown> | null> {
  if (!cached) {
    const bundlePath = resolveAggregatorSchemaPath(FORMS_BUNDLE_FILE);
    try {
      const parsed = JSON.parse(await readFile(bundlePath, 'utf8')) as { forms?: unknown };
      if (!parsed.forms || typeof parsed.forms !== 'object') {
        logger.error({
          operation: 'aggregatorForms.loadPublishedForm',
          status: 'failure',
          error: 'bundle has no `forms` object',
          path: bundlePath,
        });
        return null;
      }
      cached = parsed.forms as Record<string, unknown>;
    } catch (err) {
      logger.error({
        operation: 'aggregatorForms.loadPublishedForm',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
        path: bundlePath,
      });
      return null;
    }
  }

  const schema = cached[name];
  if (!schema || typeof schema !== 'object') {
    logger.warn({
      operation: 'aggregatorForms.loadPublishedForm',
      status: 'skipped',
      reason: 'form_absent_from_bundle',
      form: name,
    });
    return null;
  }
  return schema as Record<string, unknown>;
}

/** Test-only — clears the parsed-bundle cache. */
export function _resetFormsBundle(): void {
  cached = null;
}
