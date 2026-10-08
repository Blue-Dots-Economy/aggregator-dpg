/**
 * Organisations (network admin, user & org Phase 5): every aggregator org,
 * filtered by status, with approve / reject for pending ones and "repair
 * access" for active ones.
 */

import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { OrgsTable } from '@/components/console/OrgsTable';
import { StatusFilter } from '@/components/console/StatusFilter';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;

export default async function ConsoleOrgsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin) redirect('/console');
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status);
  const page = await consoleRead<OrgSearchResponse>('/v1/org/search', {
    filter: status ? { status } : {},
    limit: 50,
    ...(params.cursor ? { cursor: params.cursor } : {}),
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[22px] font-bold text-ink-900">{t('orgs.heading')}</h1>
      <StatusFilter action="/console/orgs" value={status ?? ''} />
      <OrgsTable orgs={page.orgs} />
      {page.next_cursor ? (
        <a
          className="text-primary-600 underline text-[13.5px]"
          href={`/console/orgs?${new URLSearchParams({
            ...(status ? { status } : {}),
            cursor: page.next_cursor,
          }).toString()}`}
        >
          {t('coordinators.next')}
        </a>
      ) : null}
    </div>
  );
}
