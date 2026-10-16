/**
 * Coordinators within reach (user & org Phase 5): filtered by org and status,
 * newest first, paged by the API's cursor.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { UserSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from '@/lib/console-api.server';
import { StatusFilter } from '@/components/console/StatusFilter';
import { ConsoleSection, ConsoleStatusPill, EmptyState } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { I } from '@/icons';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function ConsoleCoordinatorsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ status?: string; org_id?: string; cursor?: string }>;
}>) {
  const t = await getTranslations('console');
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status);
  const orgId = params.org_id && UUID_RE.test(params.org_id) ? params.org_id : undefined;
  const page = await consoleRead<UserSearchResponse>('/v1/user/search', {
    filter: { ...(status ? { status } : {}), ...(orgId ? { org_id: orgId } : {}) },
    limit: 50,
    ...(params.cursor ? { cursor: params.cursor } : {}),
  });
  const keep = { ...(status ? { status } : {}), ...(orgId ? { org_id: orgId } : {}) };
  return (
    <>
      <Topbar title={t('coordinators.heading')} subtitle={t('coordinators.subtitle')} />
      <div className="flex flex-col gap-6">
        <ConsoleSection
          flush
          action={
            <StatusFilter
              action="/console/coordinators"
              value={status ?? ''}
              hidden={orgId ? { org_id: orgId } : {}}
            />
          }
        >
          {page.users.length === 0 ? (
            <EmptyState>{t('coordinators.empty')}</EmptyState>
          ) : (
            <div className="overflow-x-auto scroll-x">
              <table className="bd-table">
                <thead>
                  <tr>
                    <th>{t('coordinators.name')}</th>
                    <th>{t('coordinators.contact')}</th>
                    <th>{t('coordinators.status')}</th>
                    <th>{t('coordinators.serves')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {page.users.map((u) => (
                    <tr key={u.id}>
                      <td className="font-semibold text-ink-900">{u.name}</td>
                      <td>
                        <div>{u.contact.name ?? u.contact.email}</div>
                        {u.contact.name ? (
                          <div className="text-[12px] text-ink-500">{u.contact.email}</div>
                        ) : null}
                      </td>
                      <td>
                        <ConsoleStatusPill status={u.status} />
                      </td>
                      <td className="bd-wrap">
                        {u.serves.length ? u.serves.join(', ') : t('coordinators.every_domain')}
                      </td>
                      <td className="text-right">
                        <Link
                          className={buttonClass('soft')}
                          href={`/console/coordinators/${u.id}`}
                        >
                          {t('coordinators.open')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ConsoleSection>
        {page.next_cursor ? (
          <div>
            <a
              className={buttonClass('ghost')}
              href={`/console/coordinators?${new URLSearchParams({ ...keep, cursor: page.next_cursor }).toString()}`}
            >
              {t('coordinators.next')}
              <I.chevR size={14} />
            </a>
          </div>
        ) : null}
      </div>
    </>
  );
}
