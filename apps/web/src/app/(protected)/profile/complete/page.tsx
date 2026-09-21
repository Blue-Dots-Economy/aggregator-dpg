import { deriveUiSchema } from '@/lib/form-layout';
import { SchemaUnavailableError } from '../../../../lib/aggregator-schema.server';
import { loadPublishedForm } from '@/lib/aggregator-forms.server';
import type { Metadata } from 'next';
import type { RJSFSchema } from '@rjsf/utils';
import { ProfileCompleteView } from './ProfileCompleteView';

export const metadata: Metadata = {
  title: 'Complete your profile',
};

export const dynamic = 'force-dynamic';

/**
 * Loads the published `profile` form and renders the post-login profile
 * completion page.
 *
 * Bundle-only since #640 — no on-disk copy remains, so an unresolvable bundle
 * throws rather than rendering an empty form the user could "submit".
 */
export default async function ProfileCompletePage() {
  const published = await loadPublishedForm('profile');
  if (!published) throw new SchemaUnavailableError('profile');
  const schema = published as RJSFSchema;
  const uiSchema = deriveUiSchema(schema);

  return <ProfileCompleteView schema={schema} uiSchema={uiSchema} />;
}
