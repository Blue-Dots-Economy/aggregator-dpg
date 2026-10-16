/**
 * Console home (user & org Phase 5, R14): an owner sees its organisations
 * with coordinator and pending counts; the network admin sees the network,
 * the organisations it owns (Default) and the organisations waiting for review.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  OrgReadResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { Card } from '@/components/ui/Card';

type OrgRow = OrgSearchResponse['orgs'][number];

export default async function ConsoleHomePage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null; // the layout already navigated away
  const me = actor.me;

  let owned: OrgRow[];
  let pending: OrgRow[] = [];
  if (me.is_network_admin) {
    // The network admin's own aggregator orgs (the Default org), read one by one.
    const ids = me.orgs.filter((o) => o.org_type === 'aggregator').map((o) => o.id);
    owned = await Promise.all(
      ids.map(async (id) => {
        const r = await consoleRead<OrgReadResponse>(`/v1/org/read/${id}`);
        return { ...r.org, coordinator_count: r.coordinator_count, pending_count: r.pending_count };
      }),
    );
    pending = (
      await consoleRead<OrgSearchResponse>('/v1/org/search', {
        filter: { status: 'pending' },
        limit: 50,
      })
    ).orgs;
  } else {
    owned = (await consoleRead<OrgSearchResponse>('/v1/org/search', { limit: 50 })).orgs;
  }
  const root = me.orgs.find((o) => o.org_type === 'network_facilitator');

  return (
    <div className="flex flex-col gap-6">
      {root ? (
        <section>
          <h1 className="font-display text-[22px] font-bold text-ink-900">
            {t('home.network_heading')}: {root.name}
          </h1>
        </section>
      ) : null}

      <section>
        <h2 className="font-display text-[18px] font-bold text-ink-900 mb-3">
          {t('home.heading')}
        </h2>
        {owned.length === 0 ? (
          <p className="text-[13.5px] text-ink-600">{t('home.no_orgs')}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {owned.map((o) => (
              <li key={o.id}>
                <Card className="p-4 flex flex-col gap-1">
                  <span className="font-semibold text-ink-900">{o.name}</span>
                  <span className="text-[13px] text-ink-600">
                    {t('home.coordinators', { count: o.coordinator_count })} ·{' '}
                    {t('home.pending', { count: o.pending_count })}
                  </span>
                  <span className="flex gap-3 text-[13px] mt-1">
                    <Link className="text-primary-600 underline" href={`/console/orgs/${o.id}`}>
                      {t('home.open')}
                    </Link>
                    <Link
                      className="text-primary-600 underline"
                      href={`/console/coordinators?org_id=${o.id}&status=pending`}
                    >
                      {t('org.view_coordinators')}
                    </Link>
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {me.is_network_admin ? (
        <section>
          <h2 className="font-display text-[18px] font-bold text-ink-900 mb-3">
            {t('home.pending_orgs')}
          </h2>
          {pending.length === 0 ? (
            <p className="text-[13.5px] text-ink-600">{t('home.none_pending')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((o) => (
                <li key={o.id}>
                  <Link className="text-primary-600 underline" href={`/console/orgs/${o.id}`}>
                    {o.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
