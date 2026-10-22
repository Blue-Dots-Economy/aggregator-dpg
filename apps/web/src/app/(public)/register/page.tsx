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
 * Public coordinator registration page.
 *
 * Loads the coordinator schema and UI schema on the server. Owner registration
 * is served only at `/register/owner`. The coordinator form always shows its
 * organisation selector.
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
