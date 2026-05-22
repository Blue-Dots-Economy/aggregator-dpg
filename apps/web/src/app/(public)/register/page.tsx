import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSession } from '../../../lib/server-session';
import { RegisterView } from './RegisterView';
import type { RJSFSchema } from '@rjsf/utils';

export const metadata: Metadata = {
  title: 'Register as Aggregator — Blue Dots',
};

export const dynamic = 'force-dynamic';

/**
 * Public aggregator registration page. Loads the JSON Schema + UI schema from
 * `config/schemas/aggregator/` on the server and hands them to the client
 * renderer so the form is config-driven, not code-driven.
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

  return <RegisterView schema={schema} uiSchema={uiSchema} />;
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
