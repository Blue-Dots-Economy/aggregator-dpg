import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { OwnerRegisterView } from './OwnerRegisterView';
import { loadConsentContent, loadOrgSchema } from '../register-server';
import { readInvite } from '../../../../lib/invite-read.server';
import { InviteUnavailable } from '../InviteUnavailable';
import { ownerSelfAddMode } from '../../../../lib/features.server';

export const metadata: Metadata = {
  title: 'Register as Aggregator Owner',
};

export const dynamic = 'force-dynamic';

interface OwnerRegisterPageProps {
  searchParams: Promise<{ invite?: string | string[] }>;
}

/**
 * Organisation registration page: `/register/owner?invite=<token>` from an org invite.
 *
 * An active session redirects to the dashboard. Without an invite the page
 * says onboarding is by invitation only. The invite is read on the server and
 * the form registers under the inviting org; an unusable invite shows why. A
 * missing org schema returns `notFound()`. When the deployment adds owners to
 * their team at registration (`owner_self_add` is `auto`), the form also asks
 * for the team member Terms and Privacy.
 */
export default async function OwnerRegisterPage({
  searchParams,
}: Readonly<OwnerRegisterPageProps>) {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const { invite } = await searchParams;
  const inviteToken = typeof invite === 'string' && invite.length > 0 ? invite : null;
  if (!inviteToken) return <InviteUnavailable reason="invite_only" />;
  const [org, consentContent, read, selfAddMode] = await Promise.all([
    loadOrgSchema(),
    loadConsentContent(),
    readInvite('org', inviteToken),
    ownerSelfAddMode(),
  ]);
  if (!org) notFound();
  if (!read.ok) return <InviteUnavailable reason={read.reason} />;

  return (
    <OwnerRegisterView
      schema={org.schema}
      uiSchema={org.uiSchema}
      orgConsentContent={consentContent?.org ?? null}
      teamConsentContent={selfAddMode === 'auto' ? (consentContent?.aggregator ?? null) : null}
      invite={{ token: inviteToken, email: read.invite.email, parentName: read.invite.org.name }}
    />
  );
}
