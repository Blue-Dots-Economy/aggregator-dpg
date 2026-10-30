import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { resolveMaxInvites } from '../../../../lib/invite-limit';
import { OwnerInviteView } from './OwnerInviteView';

export const metadata: Metadata = {
  title: 'Invite coordinators',
};

export const dynamic = 'force-dynamic';

interface OwnerInvitePageProps {
  searchParams: Promise<{ grant?: string }>;
}

/**
 * Org-owner invite page: `/register/invite?grant=<jwt>`, linked from the owner's approval email.
 *
 * An active session redirects to the dashboard. A missing `grant` returns
 * `notFound()`. The grant is not verified here; the invite POST verifies it,
 * so an expired grant shows the recovery action instead of a 404.
 */
export default async function OwnerInvitePage({ searchParams }: Readonly<OwnerInvitePageProps>) {
  const session = await getSession();
  if (session) redirect('/dashboard');
  const { grant } = await searchParams;
  if (!grant) notFound();

  return <OwnerInviteView grant={grant} maxInvites={resolveMaxInvites()} />;
}
