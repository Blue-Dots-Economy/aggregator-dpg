import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-session';
import { LoginView } from './LoginView';

export const metadata: Metadata = {
  title: 'Sign in — Blue Dots',
};

interface LoginPageProps {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await getSession();
  if (session) redirect('/blue-dots');

  const params = await searchParams;
  const returnTo = isSafePath(params.returnTo) ? params.returnTo! : '/blue-dots';
  const error = typeof params.error === 'string' ? params.error : null;

  return <LoginView returnTo={returnTo} error={error} />;
}

function isSafePath(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}
