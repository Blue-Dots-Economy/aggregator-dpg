import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { isOrgHierarchyEnabled } from '../register-server';
import { DEFAULT_MAX_INVITES, OwnerInviteView } from './OwnerInviteView';

export const metadata: Metadata = {
  title: 'Invite coordinators',
};

/**
 * Per-submission invite cap, from `INVITE_MAX_RECIPIENTS`.
 *
 * Resolved here rather than in `OwnerInviteView` because this is a server
 * component: `process.env` is read per request, so an operator can retune the
 * cap by restarting the container. The previous
 * `NEXT_PUBLIC_INVITE_MAX_RECIPIENTS` read lived in the client component, where
 * Next.js inlines the value at `next build` and changing it needed a rebuilt
 * image. Set it to the same value as the API's `INVITE_MINT_MAX_RECIPIENTS`.
 *
 * The legacy `NEXT_PUBLIC_` name is still honoured so existing deployments keep
 * working through the rename.
 *
 * `||`, NOT `??` — see the same note on `getEnabledLocales`: compose sets this
 * to an empty string when the operator's `.env` omits it, and `''` is not
 * nullish, so `??` would swallow the legacy name.
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
export default async function OwnerInvitePage({ searchParams }: Readonly<OwnerInvitePageProps>) {
  const session = await getSession();
  if (session) redirect('/dashboard');
  if (!isOrgHierarchyEnabled()) notFound();

  const { grant } = await searchParams;
  if (!grant) notFound();

  return <OwnerInviteView grant={grant} maxInvites={resolveMaxInvites()} />;
}
