import type { Metadata } from 'next';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RJSFSchema } from '@rjsf/utils';
import { ProfileCompleteView } from './ProfileCompleteView';

export const metadata: Metadata = {
  title: 'Complete your profile',
};

export const dynamic = 'force-dynamic';

/**
 * Loads the published profile schema from `config/schemas/aggregator/` and
 * renders the post-login profile completion form.
 */
export default async function ProfileCompletePage() {
  const schemaPath = resolveSchemaPath('profile.v1.json');
  const uiSchemaPath = resolveSchemaPath('profile.v1.ui.json');
  const [schemaRaw, uiSchemaRaw] = await Promise.all([
    readFile(schemaPath, 'utf8'),
    readFile(uiSchemaPath, 'utf8'),
  ]);
  const schema = JSON.parse(schemaRaw) as RJSFSchema;
  const uiSchema = JSON.parse(uiSchemaRaw) as Record<string, unknown>;

  return <ProfileCompleteView schema={schema} uiSchema={uiSchema} />;
}

function resolveSchemaPath(file: string): string {
  const candidates = [
    path.resolve(process.cwd(), '../../config/schemas/aggregator', file),
    path.resolve(process.cwd(), '../config/schemas/aggregator', file),
    path.resolve(process.cwd(), 'config/schemas/aggregator', file),
  ];
  return candidates[0]!;
}
