import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-session';
import { LoginView } from './LoginView';

const LOGOUT_REASON_COOKIE = 'bd_logout_reason';
const LOGOUT_RETURN_COOKIE = 'bd_logout_return';

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
  if (session) redirect('/dashboard');

  const params = await searchParams;
  const cookieJar = await cookies();
  // Logout flow drops these one-shot cookies because Keycloak strips query
  // strings from `post_logout_redirect_uri` (it must match the registered
  // URI exactly). Cookie values win over query string when both are set.
  const cookieReturn = cookieJar.get(LOGOUT_RETURN_COOKIE)?.value;
  const cookieReason = cookieJar.get(LOGOUT_REASON_COOKIE)?.value;

  const returnCandidate = cookieReturn ?? params.return ?? params.returnTo;
  const returnTo = isSafePath(returnCandidate) ? returnCandidate! : '/dashboard';
  const reason = cookieReason ?? (typeof params.reason === 'string' ? params.reason : null);
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
