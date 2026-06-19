import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSession } from '../../../lib/server-session';
import { RegisterView } from './RegisterView';
import type { RJSFSchema } from '@rjsf/utils';

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

  return <RegisterView schema={schema} uiSchema={uiSchema} />;
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
