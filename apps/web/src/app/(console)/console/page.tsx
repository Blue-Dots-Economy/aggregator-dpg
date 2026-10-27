/**
 * Console home page.
 *
 * An owner sees its organisations with coordinator and pending counts. The
 * network admin also sees the network and the organisations awaiting review.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  OrgReadResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { ConsoleSection, ConsoleStatusPill, EmptyState } from '@/components/console/ConsoleUi';

type OrgRow = OrgSearchResponse['orgs'][number];

export default async function ConsoleHomePage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null; // the layout already redirected
  const me = actor.me;

  let owned: OrgRow[];
  let pending: OrgRow[] = [];
  if (me.is_network_admin) {
    // The network admin's own aggregator orgs (the Default org).
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
    <>
      <Topbar
        title={root ? `${t('home.network_heading')}: ${root.name}` : t('home.heading')}
        subtitle={me.is_network_admin ? t('home.subtitle_admin') : t('home.subtitle_owner')}
      />
      <div className="flex flex-col gap-6">
        <ConsoleSection title={root ? t('home.heading') : undefined}>
          {owned.length === 0 ? (
            <p className="text-[13.5px] text-ink-500">{t('home.no_orgs')}</p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {owned.map((o) => (
                <li
                  key={o.id}
                  className="rounded-[12px] border border-(--bd-border) p-4 flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      className="font-display font-bold text-[16px] text-ink-900 hover:text-primary-600 hover:underline min-w-0 truncate"
                      href={`/console/orgs/${o.id}`}
                    >
                      {o.name}
                    </Link>
                    <ConsoleStatusPill status={o.status} />
                  </div>
                  <div className="flex gap-6">
                    <Link
                      className="group rounded-[8px] -m-1 p-1 hover:bg-(--bd-border-soft)"
                      href={`/console/coordinators?org_id=${o.id}`}
                    >
                      <div className="font-display font-bold text-[24px] leading-none text-ink-900">
                        {o.coordinator_count}
                      </div>
                      <div className="text-[12px] text-ink-500 mt-1 group-hover:underline">
                        {t('home.coordinators_label')}
                      </div>
                    </Link>
                    <Link
                      className="group rounded-[8px] -m-1 p-1 hover:bg-(--bd-border-soft)"
                      href={`/console/coordinators?org_id=${o.id}&status=pending`}
                    >
                      <div className="font-display font-bold text-[24px] leading-none text-amber-600">
                        {o.pending_count}
                      </div>
                      <div className="text-[12px] text-ink-500 mt-1 group-hover:underline">
                        {t('home.pending_label')}
                      </div>
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ConsoleSection>

        {me.is_network_admin ? (
          <ConsoleSection
            title={t('home.pending_orgs')}
            flush
            action={
              pending.length > 0 ? (
                <Link className={buttonClass('soft')} href="/console/orgs?status=pending">
                  {t('home.review')}
                </Link>
              ) : null
            }
          >
            {pending.length === 0 ? (
              <EmptyState>{t('home.none_pending')}</EmptyState>
            ) : (
              <ul>
                {pending.map((o) => (
                  <li
                    key={o.id}
                    className="flex items-center justify-between gap-3 px-5 py-3 border-b border-(--bd-border-soft) last:border-b-0"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <Link
                        className="font-semibold text-primary-600 hover:underline truncate"
                        href={`/console/orgs/${o.id}`}
                      >
                        {o.name}
                      </Link>
                      <ConsoleStatusPill status={o.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ConsoleSection>
        ) : null}
      </div>
    </>
  );
}
