import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { DEFAULT_MAX_INVITES, OwnerInviteView } from './OwnerInviteView';

export const metadata: Metadata = {
  title: 'Invite coordinators',
};

/**
 * Reads the per-submission invite cap from `INVITE_MAX_RECIPIENTS`.
 *
 * Read on the server at request time, so a restart applies a new value. Set it
 * to the same value as the API's `INVITE_MINT_MAX_RECIPIENTS`. The
 * `NEXT_PUBLIC_INVITE_MAX_RECIPIENTS` name is also accepted. Uses `||` so an
 * empty string falls through to the second name.
 *
 * @returns The configured cap, or `DEFAULT_MAX_INVITES` when unset or invalid.
 */
function resolveMaxInvites(): number {
  const raw = process.env.INVITE_MAX_RECIPIENTS || process.env.NEXT_PUBLIC_INVITE_MAX_RECIPIENTS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INVITES;
}

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
