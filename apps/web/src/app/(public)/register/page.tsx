import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '../../../lib/server-session';
import { InviteUnavailable } from './InviteUnavailable';

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
 * `/register`: onboarding is by invitation only, so this page says so and offers sign-in.
 *
 * An active session redirects to the dashboard.
 */
export default async function RegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');
  return <InviteUnavailable reason="invite_only" />;
}
