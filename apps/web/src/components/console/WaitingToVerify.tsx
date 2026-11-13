/**
 * Coordinators or organisations that registered from an invite but have not
 * yet verified their email: they join the lists above once they sign in with
 * the code.
 */

import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ConsoleSection } from './ConsoleUi';
import { WAITING_TO_VERIFY_ID } from '../../lib/waiting-to-verify';

/** One registration waiting for its email code. */
export interface WaitingRow {
  id: string;
  name: string;
  /** A second line under the name, such as the email. */
  detail?: string | null;
  /** The page that opens for this row. */
  href: string;
  /** When they registered (ISO). */
  registeredAt: string;
}

/**
 * A titled list of registrations waiting for their email code; nothing when there are none.
 *
 * @param props.rows - The registrations, newest first.
 */
export async function WaitingToVerify({ rows }: Readonly<{ rows: WaitingRow[] }>) {
  if (rows.length === 0) return null;
  const t = await getTranslations('console');
  const format = await getFormatter();
  return (
    <div id={WAITING_TO_VERIFY_ID} className="scroll-mt-6">
      <ConsoleSection title={t('waiting_to_verify.heading', { count: rows.length })} flush>
        <ul>
          {rows.map((row) => (
            <li
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-(--bd-border-soft) px-[18px] py-3 last:border-b-0 sm:grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)]"
            >
              <div className="min-w-0">
                <Link
                  href={row.href}
                  className="block truncate font-semibold text-ink-900 hover:underline"
                >
                  {row.name}
                </Link>
                {row.detail ? (
                  <div className="truncate text-[12.5px] text-ink-500">{row.detail}</div>
                ) : null}
              </div>
              <span className="justify-self-start rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap text-amber-800">
                {t('waiting_to_verify.status')}
              </span>
              <span className="text-[12.5px] text-ink-500">
                {t('waiting_to_verify.registered')}:{' '}
                {format.dateTime(new Date(row.registeredAt), {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
            </li>
          ))}
        </ul>
      </ConsoleSection>
    </div>
  );
}
