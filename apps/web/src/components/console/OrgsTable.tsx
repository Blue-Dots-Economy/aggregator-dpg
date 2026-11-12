/**
 * A list of organisations, for the network admin and for org owners. Each
 * name opens the organisation; owner access is repaired on its page.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { ConsoleStatusPill, EmptyState } from './ConsoleUi';

type OrgRow = OrgSearchResponse['orgs'][number];

export async function OrgsTable({ orgs }: Readonly<{ orgs: OrgRow[] }>) {
  const t = await getTranslations('console');
  if (orgs.length === 0) return <EmptyState>{t('orgs.empty')}</EmptyState>;
  return (
    <div className="overflow-x-auto scroll-x">
      <table className="bd-table">
        <thead>
          <tr>
            <th>{t('orgs.col_name')}</th>
            <th>{t('orgs.col_known_as')}</th>
            <th>{t('orgs.col_parent')}</th>
            <th>{t('orgs.col_status')}</th>
            <th>{t('orgs.col_counts')}</th>
          </tr>
        </thead>
        <tbody>
          {orgs.map((o) => (
            <tr key={o.id}>
              <td>
                <Link
                  className="font-semibold text-primary-600 hover:underline"
                  href={`/console/orgs/${o.id}`}
                >
                  {o.name}
                </Link>
              </td>
              <td className="text-ink-600">{o.known_as_name ?? o.known_as ?? '—'}</td>
              <td className="text-ink-600">{o.parent_name ?? '—'}</td>
              <td>
                <ConsoleStatusPill status={o.status} />
              </td>
              <td className="text-ink-600">
                {t('home.coordinators', { count: o.coordinator_count })} ·{' '}
                {t('home.pending', { count: o.pending_count })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
