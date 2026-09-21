/**
 * Server-side loader for the aggregator registration JSON Schema.
 *
 * Both the public registration page and the (read-only) authenticated profile
 * page render the *same* published `coordinator-registration` form. Keeping the
 * load + network-enum patch in one module guarantees the two surfaces never
 * drift. Belongs to the `web` app's server layer.
 *
 * Since #640 the schema comes only from the published `aggregator-forms.json`
 * on the mounted config tree — this repo no longer ships a copy, because a
 * mounted K8s deployment hid it anyway. When the bundle cannot be resolved
 * there is nothing to render, and {@link SchemaUnavailableError} is thrown
 * rather than a partial form shown.
 *
 * @module apps/web/src/lib/aggregator-schema.server
 */

import 'server-only';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { deriveUiSchema } from './form-layout';
import { loadPublishedForm } from './aggregator-forms.server';
import { aggregatorSchemaRelPaths } from './config-paths';
import type { RJSFSchema } from '@rjsf/utils';

/** Parsed registration schema pair (JSON Schema + RJSF UI schema). */
export interface AggregatorSchemaPair {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
}

/**
 * Thrown when the published bundle carries no form for this surface.
 *
 * Its own class so a page can tell "the deployment is misconfigured" apart from
 * an ordinary render fault, and so the message never implies the visitor did
 * something wrong.
 */
export class SchemaUnavailableError extends Error {
  constructor(formName: string) {
    super(
      `No published "${formName}" form in aggregator-forms.json. Check the ` +
        `schemas tree is mounted at CONFIG_ROOT and carries this scope.`,
    );
    this.name = 'SchemaUnavailableError';
  }
}

/**
 * Resolves a file under `schemas/aggregator/`, preferring a network/brand
 * override.
 *
 * Works for `pnpm --filter web dev` (cwd = apps/web), the production Docker
 * build (cwd = /app/apps/web), and the deployment where the schemas repo is
 * mounted at `CONFIG_ROOT`. Within each root the network/brand override is
 * tried before the shared default, so an instance that needs extra registration
 * fields ships its own bundle at `<network>[/<brand>]/schemas/aggregator/`
 * while every other instance keeps reading the generic one.
 *
 * Falls back to the shared-default path when nothing exists, so the caller's
 * `readFile` surfaces a normal ENOENT naming a real location.
 *
 * @param file - Bare file name, e.g. `aggregator-forms.json`.
 * @returns Absolute path to the most specific copy that exists.
 */
export function resolveAggregatorSchemaPath(file: string): string {
  const configRoot = process.env.CONFIG_ROOT?.trim();
  // An explicit CONFIG_ROOT is used exclusively: it names the initContainer's
  // mount point, and quietly falling back elsewhere when the mount is missing
  // would render a different form than the one the operator pinned.
  const roots = configRoot
    ? [path.resolve(configRoot)]
    : [
        path.resolve(process.cwd(), '../../config'),
        path.resolve(process.cwd(), '../config'),
        path.resolve(process.cwd(), 'config'),
      ];
  const rel = aggregatorSchemaRelPaths(file);
  // Specificity first, then root — a brand override in any resolvable root must
  // beat the shared default in another.
  const candidates = rel.flatMap((r) => roots.map((root) => path.join(root, r)));
  const found = candidates.find((c) => existsSync(c));
  return found ?? path.join(roots[0]!, rel.at(-1)!);
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
 * @throws {SchemaUnavailableError} When the published bundle carries no
 *   coordinator-registration form.
 */
export async function loadRegistrationSchema(): Promise<AggregatorSchemaPair> {
  const published = await loadPublishedForm('coordinator-registration');
  if (!published) throw new SchemaUnavailableError('coordinator-registration');
  const schema = published as RJSFSchema;
  const uiSchema = deriveUiSchema(schema);
  await patchTypeFromNetwork(schema, uiSchema);
  return { schema, uiSchema };
}
