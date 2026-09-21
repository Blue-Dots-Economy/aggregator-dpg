/**
 * Single access point for the aggregator's form JSON Schemas.
 *
 * Since #640 the forms are **published artefacts**, not files this repo ships:
 * they are fetched from `bluedots-schemas` via `aggregator.network.forms_source`
 * and reach us on {@link ResolvedNetworkConfig.forms}. That removal was the
 * point of the change — in a mounted K8s deployment the schemas repo is mounted
 * over `/app/config`, which hid any on-disk copy, so a mounted instance had no
 * forms at all.
 *
 * The consequence is deliberate and worth stating: there is **no local
 * fallback**. A deployment that cannot resolve its bundle has no form contract,
 * and the routes that need one return `503 SCHEMA_UNAVAILABLE` rather than
 * guessing. Accepting a registration we cannot validate would write unvalidated
 * data into the participant record; refusing is the safe half of that trade.
 *
 * Because `getNetworkConfig()` resolves once per process, recovery from a
 * cold start that missed the bundle is a **restart**, not a retry — config is
 * deliberately not re-read on the request path
 * (`.claude/rules/configuration-discipline.md`).
 *
 * @module apps/api/services/aggregator-forms
 */

import { getNetworkConfig } from './network-config.js';
import { logger } from '../logger.js';

/**
 * The forms published in an `aggregator-forms.json` bundle.
 *
 * Named for who fills the form in rather than for the code path that loads it,
 * which is why these are not the old `registration.v1` / `profile.v1` filenames.
 */
export type AggregatorFormName = 'coordinator-registration' | 'org-registration' | 'profile';

/** Env vars that select which network/brand bundle this instance resolves. */
export interface FormScopeEnv {
  AGGREGATOR_NETWORK?: string | undefined;
  AGGREGATOR_BRAND?: string | undefined;
}

/**
 * A form resolved from the published bundle, with the ref naming its origin.
 */
export interface ResolvedForm {
  /** The JSON Schema document, as published. */
  schema: Record<string, unknown>;
  /**
   * Provenance recorded on the row this form produced, e.g.
   * `blue_dot/up-gzb/coordinator-registration`.
   */
  ref: string;
}

/**
 * Returns the scope identifying which bundle this instance resolves, e.g.
 * `blue_dot/up-gzb` or bare `blue_dot`.
 *
 * This is the same pair that selects `forms_source` in the config YAML, so the
 * recorded ref always names the bundle the payload was actually checked
 * against.
 *
 * @param env - Env bag; defaults to `process.env`.
 * @returns The network id, with `/<brand>` appended when a brand is set.
 */
export function formScope(env: FormScopeEnv = process.env): string {
  const network = env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = env.AGGREGATOR_BRAND?.trim();
  return brand ? `${network}/${brand}` : network;
}

/**
 * Returns a published form and its ref, or `null` when the bundle could not be
 * resolved or does not carry that form.
 *
 * `null` rather than a throw: the caller decides whether a missing form is a
 * 503 (registration cannot proceed) or merely an unrecorded ref, and those two
 * want different handling.
 *
 * @param name - Which form to resolve.
 * @param env - Env bag used for the ref scope; defaults to `process.env`.
 * @returns The schema and its ref, or `null` when unavailable.
 */
export async function getPublishedForm(
  name: AggregatorFormName,
  env: FormScopeEnv = process.env,
): Promise<ResolvedForm | null> {
  let forms: Record<string, unknown> | undefined;
  try {
    forms = (await getNetworkConfig()).forms?.forms;
  } catch (err) {
    // A config that will not resolve is the same outcome for the caller as a
    // bundle that omits the form: no contract, so 503. Swallowing the throw
    // here keeps that a 503 rather than a 500 — the deployment is
    // misconfigured, the request is not malformed.
    logger.error({
      operation: 'aggregatorForms.getPublishedForm',
      status: 'failure',
      form: name,
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : 'unknown',
    });
    return null;
  }
  const schema = forms?.[name];
  if (!schema || typeof schema !== 'object') {
    logger.warn({
      operation: 'aggregatorForms.getPublishedForm',
      status: 'skipped',
      form: name,
      reason: forms ? 'form_absent_from_bundle' : 'no_bundle_resolved',
    });
    return null;
  }
  return { schema: schema as Record<string, unknown>, ref: `${formScope(env)}/${name}` };
}

/**
 * Returns the `profile_ref` for a published form, or `null` when the bundle
 * does not carry it.
 *
 * Storing a ref for a form that did not answer would be worse than recording
 * that the variant is unknown, so callers should log the `null` case — it means
 * the deployment's `forms_source` is missing or unreachable.
 *
 * @param name - Which form produced the payload.
 * @param env - Env bag used for the ref scope; defaults to `process.env`.
 * @returns The ref, or `null`.
 */
export async function publishedFormRef(
  name: AggregatorFormName,
  env: FormScopeEnv = process.env,
): Promise<string | null> {
  return (await getPublishedForm(name, env))?.ref ?? null;
}
