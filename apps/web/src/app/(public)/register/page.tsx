import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-session';
import { RegisterView } from './RegisterView';
import { loadRegistrationSchema } from '../../../lib/aggregator-schema.server';
import { isOrgHierarchyEnabled, loadConsentContent } from './register-server';

export const metadata: Metadata = {
  title: 'Register as Aggregator',
};

export const dynamic = 'force-dynamic';

/**
 * Public aggregator (coordinator) registration page. Loads the JSON Schema +
 * UI schema from `config/schemas/aggregator/` on the server, then the
 * coordinator form patches the `type` field's enum from the live network
 * config so the dropdown reflects the current network's domains — single
 * source of truth = signalstack `network.json`.
 *
 * Owner (organisation) registration is no longer surfaced here; it lives on
 * the `/register/owner` deep link (#619). The `ORG_HIERARCHY_ENABLED` flag is
 * still read so the coordinator's required parent-org selector renders when
 * the hierarchy is on.
 */
export default async function RegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const { schema, uiSchema } = await loadRegistrationSchema();

  const orgHierarchyEnabled = isOrgHierarchyEnabled();
  const consentContent = await loadConsentContent();

  return (
    <RegisterView
      schema={schema}
      uiSchema={uiSchema}
      orgHierarchyEnabled={orgHierarchyEnabled}
      aggregatorConsentContent={consentContent?.aggregator ?? null}
    />
  );
}
