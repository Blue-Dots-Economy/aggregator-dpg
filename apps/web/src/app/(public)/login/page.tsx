import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-session';
import { LoginView } from './LoginView';

const LOGOUT_REASON_COOKIE = 'bd_logout_reason';
const LOGOUT_RETURN_COOKIE = 'bd_logout_return';

export const metadata: Metadata = {
  title: 'Sign in',
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
  // Reasons the protected layout may hand back via the logout redirect. The
  // callback's cross-app rejections (#753) arrive as `?error=` instead, so they
  // fall through to the params branch below — listed here too because the
  // layout re-checks the same gate and can emit any of them.
  const PORTAL_GATE_REASONS = new Set([
    'org_no_portal',
    'signals_account_no_portal',
    'no_portal_access',
  ]);
  // Precedence, most specific first: an expired session, then a portal-gate
  // refusal handed back by the layout, then whatever the callback put on the
  // query string.
  function resolveError(): string | null {
    if (reason === 'expired') return 'session_expired';
    if (reason && PORTAL_GATE_REASONS.has(reason)) return reason;
    return typeof params.error === 'string' ? params.error : null;
  }
  const error = resolveError();

  return <LoginView returnTo={returnTo} error={error} />;
}

function isSafePath(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}
