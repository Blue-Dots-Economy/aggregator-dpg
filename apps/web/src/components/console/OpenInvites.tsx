/**
 * The invites nobody has used yet, newest first: the address, whether the
 * link still works, and when it was sent and expires.
 */

import { getFormatter, getTranslations } from 'next-intl/server';
import type { InviteSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { ConsoleSection, EmptyState } from './ConsoleUi';
import { cn } from '../../lib/cn';

/**
 * A titled list of open invites.
 *
 * @param props.page - The invites, as `POST …/invite/search` returns them.
 */
export async function OpenInvites({ page }: Readonly<{ page: InviteSearchResponse }>) {
  const t = await getTranslations('console');
  const format = await getFormatter();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <ConsoleSection title={`${t('open_invites.heading')} (${page.invites.length})`} flush>
      {page.invites.length === 0 ? (
        <EmptyState>{t('open_invites.empty')}</EmptyState>
      ) : (
        <ul>
          {page.invites.map((invite) => (
            <li
              key={invite.email}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-(--bd-border-soft) px-[18px] py-3 last:border-b-0 sm:grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_minmax(0,1fr)]"
            >
              <span className="truncate font-semibold text-ink-900">{invite.email}</span>
              <span
                className={cn(
                  'justify-self-start rounded-full px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap',
                  invite.status === 'pending'
                    ? 'bg-amber-50 text-amber-800'
                    : 'bg-(--bd-border-soft) text-ink-500',
                )}
              >
                {t(
                  invite.status === 'pending'
                    ? 'open_invites.status_pending'
                    : 'open_invites.status_expired',
                )}
              </span>
              <span className="text-[12.5px] text-ink-500">
                {t('open_invites.col_sent')}: {date(invite.created_at)}
              </span>
              <span className="text-[12.5px] text-ink-500">
                {t('open_invites.col_expires')}: {date(invite.expires_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {page.next_cursor ? (
        <p className="border-t border-(--bd-border-soft) px-[18px] py-3 text-[12.5px] text-ink-500">
          {t('open_invites.more', { count: page.invites.length })}
        </p>
      ) : null}
    </ConsoleSection>
  );
}
