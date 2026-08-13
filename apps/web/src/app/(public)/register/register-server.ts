import 'server-only';
import { readFile } from 'node:fs/promises';
import type { RJSFSchema } from '@rjsf/utils';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { resolveAggregatorSchemaPath } from '../../../lib/aggregator-schema.server';
import { logger } from '../../../lib/logger';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

/**
 * Server-side loaders shared by the public registration routes (`/register`
 * coordinator flow and `/register/owner` owner deep link) so the two pages
 * resolve the org schema and consent content identically. Part of the
 * `apps/web` public registration surface.
 */

/**
 * Reads whether the org → coordinator hierarchy is enabled for this instance.
 *
 * Reads the same `ORG_HIERARCHY_ENABLED` env var the API reads, server-side.
 * The owner registration deep link is gated on this — the flag is the master
 * switch for the org feature's existence, not just its discoverability.
 *
 * @returns `true` only when the env var is exactly `"true"` (trimmed).
 */
export function isOrgHierarchyEnabled(): boolean {
  return (process.env.ORG_HIERARCHY_ENABLED ?? '').trim() === 'true';
}

/**
 * Loads the org-registration JSON Schema + UI schema for the owner deep link.
 *
 * @returns The parsed org schema pair, or `null` if the files are absent or
 *   unreadable (caller treats a missing schema as the owner flow being
 *   unavailable).
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
    // Best-effort: absent org schema → owner flow unavailable.
    return null;
  }
}

/**
 * Loads the versioned consent document content for both `aggregator` and `org`
 * audiences from the network/brand config tree.
 *
 * Resolves the active network and optional brand from env vars
 * (`AGGREGATOR_NETWORK`, `AGGREGATOR_BRAND`), calls `loadConsentConfig`, and
 * extracts the `current_version` document for each audience's terms and
 * privacy fields.
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
