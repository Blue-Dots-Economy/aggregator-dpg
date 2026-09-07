import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { loadRegistrationSchema } from '../../../../lib/aggregator-schema.server';
import { isOrgHierarchyEnabled, loadConsentContent } from '../register-server';
import { CoordinatorInviteView } from './CoordinatorInviteView';

export const metadata: Metadata = {
  title: 'Accept your invitation',
};

export const dynamic = 'force-dynamic';

interface CoordinatorInvitePageProps {
  searchParams: Promise<{ invite?: string }>;
}

/**
 * Coordinator invite landing (#701): `/register/coordinator?invite=<jwt>`.
 *
 * Reached from a coordinator-invite email. Gating:
 * 1. An active session → dashboard.
 * 2. `ORG_HIERARCHY_ENABLED` off, or no `invite` token → `/login` (invite-only;
 *    a bare visit has no self-serve register path by design).
 *
 * The token is decoded client-side for display only (org name + bound email);
 * the submit endpoint is the security gate — it verifies the signature,
 * enforces the email binding, and consumes the invite.
 */
export default async function CoordinatorInvitePage({
  searchParams,
}: Readonly<CoordinatorInvitePageProps>) {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const { invite } = await searchParams;
  if (!isOrgHierarchyEnabled() || !invite) redirect('/login');

  const { schema, uiSchema } = await loadRegistrationSchema();
  const consentContent = await loadConsentContent();

  return (
    <CoordinatorInviteView
      schema={schema}
      uiSchema={uiSchema}
      inviteToken={invite}
      aggregatorConsentContent={consentContent?.aggregator ?? null}
    />
  );
}
