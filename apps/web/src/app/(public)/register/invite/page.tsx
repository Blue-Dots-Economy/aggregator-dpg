import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { isOrgHierarchyEnabled } from '../register-server';
import { OwnerInviteView } from './OwnerInviteView';

export const metadata: Metadata = {
  title: 'Invite coordinators',
};

export const dynamic = 'force-dynamic';

interface OwnerInvitePageProps {
  searchParams: Promise<{ grant?: string }>;
}

/**
 * Org-owner invite-management deep link (#701): `/register/invite?grant=<jwt>`.
 *
 * Reached from the owner's approval email — the owner cannot log in (their
 * Keycloak user is disabled by design), so this token-gated page is their only
 * surface. Gating mirrors the owner registration deep link:
 * 1. An active session → dashboard.
 * 2. `ORG_HIERARCHY_ENABLED` off → `notFound()` (no backend to mint invites).
 * 3. No `grant` param → `notFound()` (not a real entry point).
 *
 * The grant is NOT verified here — the mint POST is the gate, so an expired
 * grant lands on the recovery action rather than a dead 404.
 */
export default async function OwnerInvitePage({ searchParams }: OwnerInvitePageProps) {
  const session = await getSession();
  if (session) redirect('/dashboard');
  if (!isOrgHierarchyEnabled()) notFound();

  const { grant } = await searchParams;
  if (!grant) notFound();

  return <OwnerInviteView grant={grant} />;
}
