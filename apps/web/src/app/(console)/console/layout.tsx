/**
 * Organisation console layout (user & org Phase 5).
 *
 * Server Component. Requires a session, then resolves the actor from the API
 * (`GET /v1/user/read/me`, cached in the session ~60 s): a coordinator is sent
 * to the coordinator portal; an admin the API does not know, or one without an
 * active org, is signed out with a reason the login page explains.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { getSession } from '@/lib/server-session';
import { getConsoleActor } from '@/lib/console-actor';
import { ConsoleNav } from '@/components/console/ConsoleNav';
import { can } from '@/lib/capabilities';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const path = (await headers()).get('x-pathname') ?? '/console';
  if (!session) redirect(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
  if (session.refreshTokenExp && session.refreshTokenExp <= Date.now()) {
    redirect(`/api/auth/logout?reason=expired&return=${encodeURIComponent(path)}`);
  }

  const actor = await getConsoleActor();
  if (!actor.ok) {
    if (actor.reason === 'no_session') {
      redirect(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
    }
    if (actor.reason === 'not_approved') redirect('/dashboard');
    if (actor.reason === 'unavailable') throw new Error('console unavailable');
    redirect(
      `/api/auth/logout?reason=${actor.reason === 'no_org' ? 'console_no_org' : 'console_not_provisioned'}`,
    );
  }
  if (actor.me.kind === 'coordinator') redirect('/dashboard');

  return (
    <div className="flex flex-col lg:flex-row min-h-dvh">
      <ConsoleNav
        isNetworkAdmin={actor.me.is_network_admin}
        canManage={can(actor.me.capabilities, 'org.manage')}
      />
      <main className="flex-1 min-w-0 overflow-x-hidden">
        <div className="max-w-[1200px] mx-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
      </main>
    </div>
  );
}
