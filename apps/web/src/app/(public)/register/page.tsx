import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-session';
import { RegisterView } from './RegisterView';
import { loadRegistrationSchema } from '../../../lib/aggregator-schema.server';
import { loadConsentContent, warnIfLegacyHierarchyFlag } from './register-server';

export const metadata: Metadata = {
  title: 'Register as Aggregator',
};

export const dynamic = 'force-dynamic';

/**
 * Public aggregator (coordinator) registration page. Loads the coordinator JSON
 * Schema + UI schema from `config/schemas/aggregator/` on the server and renders
 * the single coordinator flow.
 *
 * Owner (organisation) registration is no longer a tab here — as of #619 it is
 * served only via the `/register/owner` deep link. The coordinator form always
 * shows its org selector (the hierarchy is always on since migration 0028).
 */
export default async function RegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');
  warnIfLegacyHierarchyFlag();

  const { schema, uiSchema } = await loadRegistrationSchema();
  const consentContent = await loadConsentContent();

  return (
    <RegisterView
      schema={schema}
      uiSchema={uiSchema}
      aggregatorConsentContent={consentContent?.aggregator ?? null}
    />
  );
}
