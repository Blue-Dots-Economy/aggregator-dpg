import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { OwnerRegisterView } from './OwnerRegisterView';
import { loadConsentContent, loadOrgSchema } from '../register-server';
import { readInvite } from '../../../../lib/invite-read.server';
import { InviteUnavailable } from '../InviteUnavailable';

export const metadata: Metadata = {
  title: 'Register as Aggregator Owner',
};

export const dynamic = 'force-dynamic';

interface OwnerRegisterPageProps {
  searchParams: Promise<{ invite?: string | string[] }>;
}

/**
 * Owner (organisation) registration page: `/register/owner`, or `?invite=<token>` from an org invite.
 *
 * An active session redirects to the dashboard. A missing org schema returns
 * `notFound()`. With an invite, the invite is read on the server and the form
 * registers under the inviting org; an unusable invite shows why.
 */
export default async function OwnerRegisterPage({
  searchParams,
}: Readonly<OwnerRegisterPageProps>) {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const { invite } = await searchParams;
  const inviteToken = typeof invite === 'string' && invite.length > 0 ? invite : null;
  const [org, consentContent, read] = await Promise.all([
    loadOrgSchema(),
    loadConsentContent(),
    inviteToken ? readInvite('org', inviteToken) : Promise.resolve(null),
  ]);
  if (!org) notFound();
  if (read && !read.ok) return <InviteUnavailable reason={read.reason} />;

  return (
    <OwnerRegisterView
      schema={org.schema}
      uiSchema={org.uiSchema}
      orgConsentContent={consentContent?.org ?? null}
      {...(inviteToken && read?.ok
        ? {
            invite: {
              token: inviteToken,
              email: read.invite.email,
              parentName: read.invite.org.name,
            },
          }
        : {})}
    />
  );
}
