/**
 * Server-side loader for the aggregator registration JSON Schema.
 *
 * Both the public registration page and the (read-only) authenticated profile
 * page render the *same* form from `config/schemas/aggregator/registration.v1`.
 * Keeping the load + network-enum patch in one module guarantees the two
 * surfaces never drift. Belongs to the `web` app's server layer.
 *
 * @module apps/web/src/lib/aggregator-schema.server
 */

import 'server-only';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RJSFSchema } from '@rjsf/utils';
import { aggregatorSchemaRelPaths } from './config-paths';

/** Parsed registration schema pair (JSON Schema + RJSF UI schema). */
export interface AggregatorSchemaPair {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
}

/**
 * Resolves an aggregator schema file, preferring a network/brand override.
 *
 * Works for both `pnpm --filter web dev` (cwd = apps/web) and the production
 * Docker build (cwd = /app/apps/web). Within each `config/` root the
 * network/brand override is tried before the shared default, so an instance
 * that needs extra registration fields (UP-GZB) ships its own complete copy
 * under `config/<network>[/<brand>]/schemas/aggregator/` while Purple Dot and
 * Dharwad keep rendering the generic form.
 *
 * Falls back to the shared-default path when nothing exists, so the caller's
 * `readFile` surfaces a normal ENOENT naming a real location.
 *
 * @param file - Bare schema file name, e.g. `registration.v1.json`.
 * @returns Absolute path to the most specific schema file that exists.
 */
export function resolveAggregatorSchemaPath(file: string): string {
  const roots = [
    path.resolve(process.cwd(), '../../config'),
    path.resolve(process.cwd(), '../config'),
    path.resolve(process.cwd(), 'config'),
  ];
  const rel = aggregatorSchemaRelPaths(file);
  // Specificity first, then root — a brand override in any resolvable root must
  // beat the shared default in another.
  const candidates = rel.flatMap((r) => roots.map((root) => path.join(root, r)));
  const found = candidates.find((c) => existsSync(c));
  return found ?? path.join(roots[0]!, rel[rel.length - 1]!);
}

/**
 * Replaces the static `properties.type.enum` in the registration schema and
 * `type['ui:enumNames']` in the ui schema with the current network's domain
 * ids + labels (from `GET /v1/aggregator-config`). Falls back silently to the
 * file's static values if the api is unreachable.
 *
 * Without this, the type dropdown shows the hardcoded `[seeker, provider]`
 * labels even when the live network declares different domains.
 *
 * @param schema - The loaded registration JSON Schema (mutated in place).
 * @param uiSchema - The loaded RJSF UI schema (mutated in place).
 */
export async function patchTypeFromNetwork(
  schema: RJSFSchema,
  uiSchema: Record<string, unknown>,
): Promise<void> {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${apiBase}/v1/aggregator-config`, { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = (await res.json()) as {
      domains?: Array<{ id: string; label?: string; plural_label?: string }>;
    };
    const domains = cfg?.domains ?? [];
    if (domains.length === 0) return;

    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const typeField = props?.['type'];
    if (typeField) {
      typeField['enum'] = domains.map((d) => d.id);
      typeField['oneOf'] = domains.map((d) => ({ const: d.id, title: d.label ?? d.id }));
    }

    const typeUi = (uiSchema['type'] as Record<string, unknown> | undefined) ?? {};
    typeUi['ui:enumNames'] = domains.map((d) => d.label ?? d.id);
    uiSchema['type'] = typeUi;
  } catch {
    // best-effort; static values from the files remain the fallback.
  }
}

/**
 * Loads the aggregator registration schema pair and patches the `type` enum
 * from the live network config. Shared by the registration page and the
 * read-only profile page so both render an identical form.
 *
 * @returns The parsed schema + UI schema, with the type dropdown reflecting
 *   the current network's domains.
 */
export async function loadRegistrationSchema(): Promise<AggregatorSchemaPair> {
  const [schemaRaw, uiSchemaRaw] = await Promise.all([
    readFile(resolveAggregatorSchemaPath('registration.v1.json'), 'utf8'),
    readFile(resolveAggregatorSchemaPath('registration.v1.ui.json'), 'utf8'),
  ]);
  const schema = JSON.parse(schemaRaw) as RJSFSchema;
  const uiSchema = JSON.parse(uiSchemaRaw) as Record<string, unknown>;
  await patchTypeFromNetwork(schema, uiSchema);
  return { schema, uiSchema };
}
