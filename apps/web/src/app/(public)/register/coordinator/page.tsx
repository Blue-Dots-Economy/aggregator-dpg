import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { loadRegistrationSchema } from '../../../../lib/aggregator-schema.server';
import { loadConsentContent } from '../register-server';
import { readInvite } from '../../../../lib/invite-read.server';
import { CoordinatorInviteView } from './CoordinatorInviteView';

export const metadata: Metadata = {
  title: 'Accept your invitation',
};

export const dynamic = 'force-dynamic';

interface CoordinatorInvitePageProps {
  searchParams: Promise<{ invite?: string }>;
}

/**
 * Coordinator invite landing page: `/register/coordinator?invite=<jwt>`.
 *
 * An active session redirects to the dashboard. A missing `invite` token
 * redirects to `/login`. The invite is read on the server; the accept
 * endpoint checks it again, enforces the email and uses it up.
 */
export default async function CoordinatorInvitePage({
  searchParams,
}: Readonly<CoordinatorInvitePageProps>) {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const { invite } = await searchParams;
  if (!invite) redirect('/login');

  const [{ schema, uiSchema }, consentContent, read] = await Promise.all([
    loadRegistrationSchema(),
    loadConsentContent(),
    readInvite('user', invite),
  ]);

  return (
    <CoordinatorInviteView
      schema={schema}
      uiSchema={uiSchema}
      inviteToken={invite}
      invite={read}
      aggregatorConsentContent={consentContent?.aggregator ?? null}
    />
  );
}
