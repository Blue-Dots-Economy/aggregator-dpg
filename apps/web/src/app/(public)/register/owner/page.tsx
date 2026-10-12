import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { OwnerRegisterView } from './OwnerRegisterView';
import { loadConsentContent, loadOrgSchema } from '../register-server';

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
 * 2. Org schema absent ⇒ `notFound()`. Without the schema the owner form
 *    cannot be rendered.
 *
 * Otherwise it renders the owner form inside the brand shell.
 */
export default async function OwnerRegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

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
