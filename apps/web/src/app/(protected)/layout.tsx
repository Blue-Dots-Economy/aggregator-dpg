/**
 * Layout for the protected coordinator pages.
 *
 * Server Component that runs on every `/(protected)/*` request. Without a
 * session it redirects to the BFF login with a `returnTo` back to the page.
 * Coordinators with outstanding terms go to the terms page.
 * It passes the session user, `supportEnabled`, and capabilities to the
 * client `AuthProvider`.
 *
 * An org owner whose session holds an acting account uses these pages as that
 * coordinator account. When `/me` refuses the account, the layout ends acting
 * mode and sends the owner to the console with a notice.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Sidebar } from '../../components/shell/Sidebar';
import { AuthProvider } from '../../lib/auth-context';
import { getSession } from '../../lib/server-session';
import { PORTAL_GATE_REASON, classifyNonCoordinator, tokenAggregatorId } from '../../lib/jwt';
import { resolveSignalsRealmRoles } from '../../lib/signals-roles';
import type { User } from '../../types';
import { getConsoleActor, type ConsoleActorResult } from '../../lib/console-actor';
import { fetchSupportEnabled } from '@/lib/support-enabled.server';
import { ensureTermsAccepted } from '@/lib/terms-guard.server';
import { ACTING_ENDED_HREF } from '@/lib/acting';
import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';
import type { SessionData } from '@/lib/session';

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const path = (await headers()).get('x-pathname') ?? '/';

  if (!session) {
    redirect(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
  }

  // An expired refresh token ends the session. Log out to clear the cookie.
  const now = Date.now();
  if (session.refreshTokenExp && session.refreshTokenExp <= now) {
    redirect(`/api/auth/logout?reason=expired&return=${encodeURIComponent(path)}`);
  }

  // Only coordinators (tokens with `aggregator_id`) and org owners acting as
  // their own coordinator account use this portal. Other org owners go to the
  // console; everyone else is logged out with a reason.
  const acting = session.actingAccountId !== undefined;
  if (!acting && !tokenAggregatorId(session.accessToken)) {
    const population = classifyNonCoordinator(
      session.accessToken,
      await resolveSignalsRealmRoles(),
    );
    if (population === 'org_owner') redirect('/console');
    redirect(`/api/auth/logout?reason=${PORTAL_GATE_REASON[population]}`);
  }

  // Outstanding terms send the coordinator to the terms page first.
  await ensureTermsAccepted(path);

  const supportEnabled = await fetchSupportEnabled();
  // Capabilities hide UI the coordinator cannot use. On failure nothing is
  // hidden; the API still checks every request.
  const actor = await getConsoleActor();
  if (acting && !actingActorUsable(actor)) redirect(ACTING_ENDED_HREF);
  const capabilities = actor.ok ? (actor.me.capabilities ?? null) : null;
  const user = acting && actor.ok ? accountUser(actor.me) : sessionUser(session);
  // Acting mode stays visible on a transient `/me` failure; only the org name is missing then.
  const actingInfo = acting ? { orgName: actor.ok ? coordinatorOrgName(actor.me) : null } : null;

  return (
    <AuthProvider
      initialUser={user}
      supportEnabled={supportEnabled}
      capabilities={capabilities}
      acting={actingInfo}
    >
      {/* Column layout below `lg`, row layout from `lg` up. */}
      <div className="flex flex-col lg:flex-row min-h-dvh">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-x-hidden">
          <div className="max-w-[1480px] mx-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
        </main>
      </div>
    </AuthProvider>
  );
}

/** The shell's user while acting: the coordinator account from `/me`. */
function accountUser(me: MeResponse): User {
  const { contact } = me.user;
  return {
    id: me.user.id,
    name: contact.name ?? contact.email,
    org: contact.email,
    email: contact.email,
    ...(contact.phone ? { phone: contact.phone } : {}),
  };
}

/** The shell's user from the signed-in session. */
function sessionUser(session: SessionData): User {
  return {
    id: session.sub,
    name: session.name ?? session.email ?? session.phone ?? session.sub,
    org: session.email ?? '',
    ...(session.email ? { email: session.email } : {}),
    ...(session.phone ? { phone: session.phone } : {}),
  };
}

/**
 * Whether `/me` still answers as the acting coordinator account.
 *
 * A refused account, or an answer as anyone else, ends acting mode. Other
 * failures keep it: the API still checks every request.
 */
function actingActorUsable(actor: ConsoleActorResult): boolean {
  if (actor.ok) return actor.me.kind === 'coordinator';
  return actor.reason !== 'acting_invalid';
}

/** The coordinator account's organisation name, for the shell and the onboarding banner; null when unknown. */
function coordinatorOrgName(me: MeResponse): string | null {
  return (me.orgs.find((o) => o.org_type === 'aggregator') ?? me.orgs[0])?.name || null;
}
