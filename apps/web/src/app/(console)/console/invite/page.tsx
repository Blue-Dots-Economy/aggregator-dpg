/**
 * Invites coordinators into an active organisation where the actor holds
 * `org.manage`.
 *
 * The Default org is never offered.
 */

import { getTranslations } from 'next-intl/server';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from '@/lib/console-api.server';
import { InviteForm } from '@/components/console/InviteForm';
import { ConsoleSection } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';
import { getConsoleActor } from '@/lib/console-actor';
import { canInvite, canManageOrg } from '@/lib/capabilities';
import { redirect } from 'next/navigation';

export default async function ConsoleInvitePage() {
  const t = await getTranslations('console');
  // Inviting needs `org.manage` in an organisation that takes invites.
  // The API also checks it.
  const actor = await getConsoleActor();
  if (actor.ok && !canInvite(actor.me)) redirect('/console');
  const page = await consoleRead<OrgSearchResponse>('/v1/org/search', {
    filter: { status: 'active' },
    limit: 100,
  });
  const orgs = page.orgs
    .filter((o) => !o.is_default && (!actor.ok || canManageOrg(actor.me, o.id)))
    .map((o) => ({ id: o.id, name: o.name }));
  return (
    <>
      <Topbar title={t('invite.heading')} subtitle={t('invite.subtitle')} />
      <div className="flex flex-col gap-6">
        {orgs.length === 0 ? (
          <ConsoleSection>
            <p className="text-[13.5px] text-ink-500">{t('invite.no_orgs')}</p>
          </ConsoleSection>
        ) : (
          <InviteForm orgs={orgs} />
        )}
      </div>
    </>
  );
}
