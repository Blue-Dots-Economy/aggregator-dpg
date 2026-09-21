/**
 * Resolves an aggregator form schema from the published bundle.
 *
 * The forms used to be read from the image's own `config/schemas/aggregator/`,
 * which this repo no longer ships. In a mounted K8s deployment the schemas repo
 * is mounted over `/app/config`, hiding them entirely — the gap
 * aggregator-dpg#640 closes. They are now published as `aggregator-forms.json`
 * per network/brand and fetched through the same cache-backed loader as
 * `network.json`, served to this app by `GET /v1/aggregator-forms`.
 *
 * Returns `null` on every failure — no `forms_source`, timeout, non-2xx,
 * malformed body, missing key — rather than throwing, so the caller decides
 * what an absent form means for its surface. There is no on-disk fallback left:
 * `null` means the page has nothing to render and says so.
 *
 * @module apps/web/src/lib/aggregator-forms.server
 */

import 'server-only';
import { logger } from './logger';

/** Bundle keys, named for who fills the form in rather than the code path. */
export type AggregatorFormName = 'coordinator-registration' | 'org-registration' | 'profile';

const FETCH_TIMEOUT_MS = 3_000;

/**
 * Fetches one form schema from the published bundle.
 *
 * @param name - Which form to take from the bundle.
 * @returns The schema, or null when it cannot be resolved for any reason.
 */
export async function loadPublishedForm(
  name: AggregatorFormName,
): Promise<Record<string, unknown> | null> {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const start = Date.now();
  try {
    const res = await fetch(`${apiBase}/v1/aggregator-forms`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({
        operation: 'aggregatorForms.loadPublished',
        status: 'failure',
        error: `HTTP ${res.status}`,
        latency_ms: Date.now() - start,
        form: name,
      });
      return null;
    }
    const body = (await res.json()) as {
      forms?: Record<string, Record<string, unknown>> | null;
    };
    const form = body.forms?.[name];
    if (!form) {
      // Absent is normal: no `forms_source` configured, or a bundle that does
      // not serve this form. Logged at debug so a rollout is visible without
      // making the common case noisy.
      logger.debug({
        operation: 'aggregatorForms.loadPublished',
        status: 'skipped',
        form: name,
        latency_ms: Date.now() - start,
      });
      return null;
    }
    return form;
  } catch (err) {
    logger.warn({
      operation: 'aggregatorForms.loadPublished',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
      form: name,
    });
    return null;
  }
}
