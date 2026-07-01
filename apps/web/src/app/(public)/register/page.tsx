import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSession } from '../../../lib/server-session';
import { RegisterView } from './RegisterView';
import type { RJSFSchema } from '@rjsf/utils';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { logger } from '../../../lib/logger';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

export const metadata: Metadata = {
  title: 'Register as Aggregator',
};

export const dynamic = 'force-dynamic';

/**
 * Public aggregator registration page. Loads the JSON Schema + UI schema from
 * `config/schemas/aggregator/` on the server, then patches the `type` field's
 * enum from the live network config so the dropdown reflects the current
 * network's domains (e.g. `[seeker, provider]` for purple/orange,
 * `[seeker, provider]` for blue, or whatever a future network declares) —
 * single source of truth = signalstack `network.json`.
 */
export default async function RegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const schemaPath = resolveSchemaPath('registration.v1.json');
  const uiSchemaPath = resolveSchemaPath('registration.v1.ui.json');
  const [schemaRaw, uiSchemaRaw] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    readFile(uiSchemaPath, 'utf8'),
  ]);
  const schema = JSON.parse(schemaRaw) as RJSFSchema;
  const uiSchema = JSON.parse(uiSchemaRaw) as Record<string, unknown>;

  await patchTypeFromNetwork(schema, uiSchema);

  // Org hierarchy is a per-instance deploy flag — read the same env var the API
  // reads, server-side (this route is `force-dynamic`). When on, also load the
  // org-registration schema so the org tab can render. A flag-on instance whose
  // config is missing the org schema degrades gracefully to the coordinator-only
  // form rather than 500-ing the register page.
  const orgHierarchyEnabled = (process.env.ORG_HIERARCHY_ENABLED ?? '').trim() === 'true';
  const [org, consentContent] = await Promise.all([
    orgHierarchyEnabled ? loadOrgSchema() : Promise.resolve(null),
    loadConsentContent(),
  ]);

  return (
    <RegisterView
      schema={schema}
      uiSchema={uiSchema}
      orgHierarchyEnabled={orgHierarchyEnabled}
      aggregatorConsentContent={consentContent?.aggregator ?? null}
      orgConsentContent={consentContent?.org ?? null}
      {...(org ? { orgSchema: org.schema, orgUiSchema: org.uiSchema } : {})}
    />
  );
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
 *   `null` if the config file is absent or invalid (caller passes `null` to
 *   both forms — they degrade to plain text labels).
 */
async function loadConsentContent(): Promise<{
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
 * Loads the org-registration JSON Schema + UI schema for the org tab.
 *
 * @returns The parsed org schema pair, or `null` if the files are absent or
 *   unreadable (a flag-on instance without the schema falls back to the
 *   coordinator-only form).
 */
async function loadOrgSchema(): Promise<{
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
} | null> {
  try {
    const [rawSchema, rawUi] = await Promise.all([
      readFile(resolveSchemaPath('org-registration.v1.json'), 'utf8'),
      readFile(resolveSchemaPath('org-registration.v1.ui.json'), 'utf8'),
    ]);
    return {
      schema: JSON.parse(rawSchema) as RJSFSchema,
      uiSchema: JSON.parse(rawUi) as Record<string, unknown>,
    };
  } catch {
    // Best-effort: absent org schema → coordinator-only form.
    return null;
  }
}

/**
 * Replaces the static `properties.type.enum` in the registration schema
 * and `type['ui:enumNames']` in the ui schema with the current network's
 * domain ids + labels (from `/v1/aggregator-config`). Falls back silently
 * to the file's static values if the api is unreachable.
 *
 * Without this, the dropdown shows the hardcoded `[seeker, provider]`
 * labels even when the live network declares different domains.
 */
async function patchTypeFromNetwork(
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

    // 1. Schema — replace enum + add oneOf so the JSON Schema itself
    //    captures the live set (validation + non-RJSF readers).
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const typeField = props?.['type'];
    if (typeField) {
      typeField['enum'] = domains.map((d) => d.id);
      typeField['oneOf'] = domains.map((d) => ({
        const: d.id,
        title: d.label ?? d.id,
      }));
    }

    // 2. UI schema — replace `ui:enumNames` so the RJSF Select widget
    //    shows the network's domain labels instead of the hardcoded
    //    ["Seeker", "Provider"].
    const typeUi = (uiSchema['type'] as Record<string, unknown> | undefined) ?? {};
    typeUi['ui:enumNames'] = domains.map((d) => d.label ?? d.id);
    uiSchema['type'] = typeUi;
  } catch {
    // best-effort; static values from the files remain the fallback.
  }
}

function resolveSchemaPath(file: string): string {
  // Walk up from the running cwd to find the monorepo root that contains
  // `config/schemas/aggregator/`. Works for both `pnpm --filter web dev`
  // (cwd = apps/web) and the production Docker build (cwd = /app/apps/web).
  const candidates = [
    path.resolve(process.cwd(), '../../config/schemas/aggregator', file),
    path.resolve(process.cwd(), '../config/schemas/aggregator', file),
    path.resolve(process.cwd(), 'config/schemas/aggregator', file),
  ];
  return candidates[0]!;
}
