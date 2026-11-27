import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '../../../../lib/server-session';
import { InviteUnavailable } from '../InviteUnavailable';

/**
 * Sets the page title.
 *
 * @returns The page metadata.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('register');
  return { title: t('invite_heading_invalid') };
}

export const dynamic = 'force-dynamic';

/**
 * `/register/invite?grant=`: the link older approval emails carried. Owners now
 * invite from the console, so the page asks them to sign in.
 *
 * An active session redirects to the console.
 */
export default async function OwnerGrantLinkPage() {
  const session = await getSession();
  if (session) redirect('/console');
  return <InviteUnavailable reason="grant_retired" />;
}
