import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-session';
import { LoginView } from './LoginView';

export const metadata: Metadata = {
  title: 'Sign in — Blue Dots',
};

interface LoginPageProps {
  searchParams: Promise<{
    returnTo?: string;
    return?: string;
    error?: string;
    reason?: string;
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await getSession();
  if (session) redirect('/blue-dots');

  const params = await searchParams;
  // Accept both `returnTo` (legacy) and `return` (set by the logout flow).
  const returnCandidate = params.return ?? params.returnTo;
  const returnTo = isSafePath(returnCandidate) ? returnCandidate! : '/blue-dots';
  const reason = typeof params.reason === 'string' ? params.reason : null;
  // Map well-known reasons to error codes the LoginView already understands.
  const error =
    reason === 'expired'
      ? 'session_expired'
      : typeof params.error === 'string'
        ? params.error
        : null;

  return <LoginView returnTo={returnTo} error={error} />;
}

function isSafePath(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}
