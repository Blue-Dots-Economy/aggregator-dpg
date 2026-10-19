/**
 * Organisation console layout (user & org Phase 5).
 *
 * Server Component. Requires a session, then resolves the actor from the API
 * (`GET /v1/user/read/me`, cached in the session ~60 s): a coordinator is sent
 * to the coordinator portal; an admin the API does not know, or one without an
 * active org, is signed out with a reason the login page explains.
 *
 * The frame is the coordinator portal's: the shared sidebar (brand, icon nav,
 * mobile drawer, account card) beside the page. Contact support stays off:
 * the support API accepts coordinators only.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { getSession } from '@/lib/server-session';
import { getConsoleActor } from '@/lib/console-actor';
import { getTranslations } from 'next-intl/server';
import { ConsoleSidebar } from '@/components/console/ConsoleSidebar';
import { AuthProvider } from '@/lib/auth-context';
import { can, canViewCoordinators } from '@/lib/capabilities';

export default async function ConsoleLayout({ children }: Readonly<{ children: ReactNode }>) {
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

  const t = await getTranslations('console');
  const me = actor.me;
  const name = me.user.contact.name ?? me.user.contact.email;
  return (
    <AuthProvider
      initialUser={{ id: me.user.id, name, org: '', email: me.user.contact.email }}
      supportEnabled={false}
      capabilities={me.capabilities ?? null}
    >
      {/* Column below `lg` (menu bar above the page), row from `lg` up, as in
          the coordinator portal (#793). */}
      <div className="flex flex-col lg:flex-row min-h-dvh">
        <ConsoleSidebar
          isNetworkAdmin={me.is_network_admin}
          canManage={canViewCoordinators(me)}
          canViewAccess={me.is_network_admin && can(me.capabilities, 'network.administer')}
          account={{
            title: name,
            subtitle: me.is_network_admin ? t('nav.network_admin') : t('nav.org_owner'),
          }}
        />
        <main className="flex-1 min-w-0 overflow-x-hidden">
          <div className="max-w-[1480px] mx-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
        </main>
      </div>
    </AuthProvider>
  );
}
