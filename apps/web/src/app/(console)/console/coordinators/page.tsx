/**
 * Coordinators within reach (user & org Phase 5): filtered by org and status,
 * newest first, paged by the API's cursor.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { UserSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from '@/lib/console-api.server';
import { StatusFilter } from '@/components/console/StatusFilter';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function ConsoleCoordinatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; org_id?: string; cursor?: string }>;
}) {
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
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[22px] font-bold text-ink-900">
        {t('coordinators.heading')}
      </h1>
      <StatusFilter
        action="/console/coordinators"
        value={status ?? ''}
        hidden={orgId ? { org_id: orgId } : {}}
      />
      {page.users.length === 0 ? (
        <p className="text-[13.5px] text-ink-600">{t('coordinators.empty')}</p>
      ) : (
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="text-left text-ink-600">
              <th className="py-2">{t('coordinators.name')}</th>
              <th>{t('coordinators.contact')}</th>
              <th>{t('coordinators.status')}</th>
              <th>{t('coordinators.serves')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {page.users.map((u) => (
              <tr key={u.id} className="border-t border-(--bd-border)">
                <td className="py-2">{u.name}</td>
                <td>{u.contact.name ?? u.contact.email}</td>
                <td>{t(`status.${u.status}`)}</td>
                <td>{u.serves.length ? u.serves.join(', ') : t('coordinators.every_domain')}</td>
                <td>
                  <Link
                    className="text-primary-600 underline"
                    href={`/console/coordinators/${u.id}`}
                  >
                    {t('coordinators.open')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {page.next_cursor ? (
        <a
          className="text-primary-600 underline text-[13.5px]"
          href={`/console/coordinators?${new URLSearchParams({ ...keep, cursor: page.next_cursor }).toString()}`}
        >
          {t('coordinators.next')}
        </a>
      ) : null}
    </div>
  );
}
