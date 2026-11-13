/**
 * Organisations that registered from an invite but whose owner has not yet
 * verified their email: they join the tree once the owner signs in with the code.
 */

import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { ConsoleSection } from './ConsoleUi';

type OrgRow = OrgSearchResponse['orgs'][number];

/**
 * A titled list of registered organisations waiting for their owner's email code; nothing when there are none.
 *
 * @param props.orgs - The pending organisations directly under the viewer's organisation.
 */
export async function RegisteredOrgs({ orgs }: Readonly<{ orgs: OrgRow[] }>) {
  if (orgs.length === 0) return null;
  const t = await getTranslations('console');
  const format = await getFormatter();
  return (
    <ConsoleSection title={t('registered_orgs.heading', { count: orgs.length })} flush>
      <ul>
        {orgs.map((org) => (
          <li
            key={org.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-(--bd-border-soft) px-[18px] py-3 last:border-b-0 sm:grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)]"
          >
            <Link
              href={`/console/orgs/${org.id}`}
              className="truncate font-semibold text-ink-900 hover:underline"
            >
              {org.name}
            </Link>
            <span className="justify-self-start rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap text-amber-800">
              {t('registered_orgs.status')}
            </span>
            <span className="text-[12.5px] text-ink-500">
              {t('registered_orgs.registered')}:{' '}
              {format.dateTime(new Date(org.created_at), {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          </li>
        ))}
      </ul>
    </ConsoleSection>
  );
}
