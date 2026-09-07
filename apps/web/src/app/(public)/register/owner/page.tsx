import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { OwnerRegisterView } from './OwnerRegisterView';
import { isOrgHierarchyEnabled, loadConsentContent, loadOrgSchema } from '../register-server';

export const metadata: Metadata = {
  title: 'Register as Aggregator Owner',
};

export const dynamic = 'force-dynamic';

/**
 * Owner (organisation) registration deep link (#619). Not linked from the
 * public `/register` page — reachable only by direct URL / QR.
 *
 * Gating (in order):
 * 1. An active session redirects to the dashboard, like `/register`.
 * 2. `ORG_HIERARCHY_ENABLED` off ⇒ `notFound()`. The flag is the master switch
 *    for the org feature's existence — with it off there is no backend route
 *    to accept an owner registration, so the deep link must not resurrect it.
 * 3. Org schema absent ⇒ `notFound()`. Without the schema the owner form
 *    cannot be rendered.
 *
 * Otherwise it renders the owner form inside the brand shell.
 */
export default async function OwnerRegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

  if (!isOrgHierarchyEnabled()) notFound();

  const [org, consentContent] = await Promise.all([loadOrgSchema(), loadConsentContent()]);
  if (!org) notFound();

  return (
    <OwnerRegisterView
      schema={org.schema}
      uiSchema={org.uiSchema}
      orgConsentContent={consentContent?.org ?? null}
    />
  );
}
