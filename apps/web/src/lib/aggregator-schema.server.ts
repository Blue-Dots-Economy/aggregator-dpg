/**
 * Server-side loader for the aggregator registration JSON Schema.
 *
 * The registration page and the read-only profile page both render the form
 * from `registration.v1` loaded here, so they stay the same.
 *
 * @module apps/web/src/lib/aggregator-schema.server
 */

import { applyUrlRule } from '@aggregator-dpg/network-config/uri-fields';
import 'server-only';
import { readDomainLabels } from './aggregator-config-domains';
import { parseJsonObject, parseJsonSchema, readJsonObject } from './json-object';
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
 * Works with cwd `apps/web` (dev) and `/app/apps/web` (Docker). Returns the
 * shared-default path when no file exists, so `readFile` fails with ENOENT.
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
  // Most specific path first, across all roots.
  const candidates = rel.flatMap((r) => roots.map((root) => path.join(root, r)));
  const found = candidates.find((c) => existsSync(c));
  return found ?? path.join(roots[0]!, rel.at(-1)!);
}

/**
 * Replaces the `type` options in the schema and UI schema with the network's
 * domains from `GET /v1/aggregator-config`.
 *
 * Keeps the file's static values if the api is unreachable.
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
    const domains = readDomainLabels(await res.json()) ?? [];
    if (domains.length === 0) return;

    const typeField = schema.properties?.['type'];
    if (typeof typeField === 'object') {
      typeField.enum = domains.map((d) => d.id);
      typeField.oneOf = domains.map((d) => ({ const: d.id, title: d.label }));
    }

    uiSchema['type'] = {
      ...readJsonObject(uiSchema['type']),
      'ui:enumNames': domains.map((d) => d.label),
    };
  } catch {
    // Best-effort; the static values remain.
  }
}

/**
 * Loads the aggregator registration schema pair and patches the `type` enum
 * from the network config.
 *
 * @returns The parsed schema and UI schema.
 */
export async function loadRegistrationSchema(): Promise<AggregatorSchemaPair> {
  const [schemaRaw, uiSchemaRaw] = await Promise.all([
    readFile(resolveAggregatorSchemaPath('registration.v1.json'), 'utf8'),
    readFile(resolveAggregatorSchemaPath('registration.v1.ui.json'), 'utf8'),
  ]);
  // The same web-address rule the API and Signals apply, so the form refuses
  // what the server would refuse and says why.
  const schema = applyUrlRule(parseJsonSchema(schemaRaw));
  const uiSchema = parseJsonObject(uiSchemaRaw);
  await patchTypeFromNetwork(schema, uiSchema);
  return { schema, uiSchema };
}
