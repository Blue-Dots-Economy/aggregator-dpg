/**
 * Invite coordinators (user & org Phase 5): into an active organisation the
 * actor owns (any active org for the network admin); never the Default org.
 */

import { getTranslations } from 'next-intl/server';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from '@/lib/console-api.server';
import { InviteForm } from '@/components/console/InviteForm';

export default async function ConsoleInvitePage() {
  const t = await getTranslations('console');
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
