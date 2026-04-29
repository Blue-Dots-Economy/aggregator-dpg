/**
 * Protected route group layout.
 *
 * Server Component — runs on every request to a `/(protected)/*` page.
 * If no session is present, redirects to the BFF login endpoint with a
 * `returnTo` query so the user lands back on the deep-linked page after
 * authenticating.
 *
 * Hydrates the client `AuthProvider` with the session snapshot so child
 * client components (Sidebar, etc.) can read user info without an extra
 * fetch.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Sidebar } from '../../components/shell/Sidebar';
import { AuthProvider } from '../../lib/auth-context';
import { getSession } from '../../lib/server-session';
import type { User } from '../../types';

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) {
    const path = (await headers()).get('x-pathname') ?? '/';
    redirect(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
  }

  const user: User = {
    id: session.sub,
    name: session.name ?? session.email ?? session.phone ?? session.sub,
    org: session.email ?? '',
  };

  return (
    <AuthProvider initialUser={user}>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-x-hidden">
          <div className="max-w-[1480px] mx-auto px-8 py-7">{children}</div>
        </main>
      </div>
    </AuthProvider>
  );
}
