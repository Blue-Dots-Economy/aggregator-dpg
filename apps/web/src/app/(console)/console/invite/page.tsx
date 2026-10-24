/**
 * Invites coordinators into an active organisation the actor can manage.
 *
 * The Default org is never offered.
 */

import { getTranslations } from 'next-intl/server';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from '@/lib/console-api.server';
import { InviteForm } from '@/components/console/InviteForm';
import { getConsoleActor } from '@/lib/console-actor';
import { can } from '@/lib/capabilities';
import { redirect } from 'next/navigation';

export default async function ConsoleInvitePage() {
  const t = await getTranslations('console');
  // Inviting needs `org.manage`; the API also checks it.
  const actor = await getConsoleActor();
  if (actor.ok && !can(actor.me.capabilities, 'org.manage')) redirect('/console');
  const page = await consoleRead<OrgSearchResponse>('/v1/org/search', {
    filter: { status: 'active' },
    limit: 100,
  });
  const orgs = page.orgs.filter((o) => !o.is_default).map((o) => ({ id: o.id, name: o.name }));
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[22px] font-bold text-ink-900">{t('invite.heading')}</h1>
      {orgs.length === 0 ? (
        <p className="text-[13.5px] text-ink-600">{t('invite.no_orgs')}</p>
      ) : (
        <InviteForm orgs={orgs} />
      )}
    </div>
  );
}
