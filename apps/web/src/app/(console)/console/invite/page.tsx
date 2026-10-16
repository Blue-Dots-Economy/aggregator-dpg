/**
 * Invite coordinators (user & org Phase 5): into an active organisation the
 * actor may manage (`org.manage` there, #873); never the Default org.
 */

import { getTranslations } from 'next-intl/server';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from '@/lib/console-api.server';
import { InviteForm } from '@/components/console/InviteForm';
import { ConsoleSection } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';
import { getConsoleActor } from '@/lib/console-actor';
import { can, canManageOrg } from '@/lib/capabilities';
import { redirect } from 'next/navigation';

export default async function ConsoleInvitePage() {
  const t = await getTranslations('console');
  // RBAC: inviting needs `org.manage` (the API also checks it).
  const actor = await getConsoleActor();
  if (actor.ok && !can(actor.me.capabilities, 'org.manage')) redirect('/console');
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
