/**
 * Server-only helpers shared by the public registration routes — the
 * coordinator page (`/register`) and the owner deep link (`/register/owner`,
 * #619). Extracted so both routes resolve the org-hierarchy flag, the org
 * schema, and the versioned consent content the same way.
 *
 * @module apps/web/src/app/(public)/register/register-server
 */

import 'server-only';
import { readFile } from 'node:fs/promises';
import type { RJSFSchema } from '@rjsf/utils';
import { resolveAggregatorSchemaPath } from '../../../lib/aggregator-schema.server';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { logger } from '../../../lib/logger';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

/**
 * Whether the org → coordinator hierarchy is enabled for this instance. Reads
 * the same `ORG_HIERARCHY_ENABLED` env var the API reads; both registration
 * routes are `force-dynamic`, so this is evaluated per request.
 *
 * @returns True when the flag is set to `'true'`.
 */
export function isOrgHierarchyEnabled(): boolean {
  return (process.env.ORG_HIERARCHY_ENABLED ?? '').trim() === 'true';
}

/**
 * Loads the versioned consent document content for both `aggregator` and `org`
 * audiences from the network/brand config tree.
 *
 * @returns An object with `aggregator` and `org` {@link ConsentDocContent}, or
 *   `null` if the config file is absent or invalid (callers pass `null` to the
 *   forms — they degrade to plain text labels).
 */
export async function loadConsentContent(): Promise<{
  aggregator: ConsentDocContent;
  org: ConsentDocContent;
} | null> {
  const network = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim() || undefined;
  try {
    const cfg = await loadConsentConfig(network, brand);

    const pickDoc = (doc: {
      current_version: number;
      versions: Array<{ version: number; title: string; content: string; effective_from: string }>;
    }): { version: number; title: string; content: string } => {
      const found = doc.versions.find((v) => v.version === doc.current_version);
      if (!found) throw new Error(`current_version ${doc.current_version} not found in versions`);
      return { version: found.version, title: found.title, content: found.content };
    };

    return {
      aggregator: {
        terms: pickDoc(cfg.audiences.aggregator.documents.terms),
        privacy: pickDoc(cfg.audiences.aggregator.documents.privacy),
      },
      org: {
        terms: pickDoc(cfg.audiences.org.documents.terms),
        privacy: pickDoc(cfg.audiences.org.documents.privacy),
      },
    };
  } catch (err) {
    logger.warn({
      operation: 'loadConsentContent',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      network,
      brand,
    });
    return null;
  }
}

/**
 * Loads the org-registration JSON Schema + UI schema.
 *
 * @returns The parsed org schema pair, or `null` if the files are absent or
 *   unreadable.
 */
export async function loadOrgSchema(): Promise<{
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
} | null> {
  try {
    const [rawSchema, rawUi] = await Promise.all([
      readFile(resolveAggregatorSchemaPath('org-registration.v1.json'), 'utf8'),
      readFile(resolveAggregatorSchemaPath('org-registration.v1.ui.json'), 'utf8'),
    ]);
    return {
      schema: JSON.parse(rawSchema) as RJSFSchema,
      uiSchema: JSON.parse(rawUi) as Record<string, unknown>,
    };
  } catch {
    // Best-effort: absent org schema → owner route 404s / coordinator-only.
    return null;
  }
}
