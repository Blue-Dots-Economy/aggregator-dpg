/** The names list on the invite form: one row per valid email with an optional name. */

import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { Recipient } from './invite-recipients';

/** One row per valid email with an optional name for the greeting. */
export function NamesList({
  people,
  onName,
  onRemove,
}: Readonly<{
  people: readonly Recipient[];
  onName: (email: string, name: string) => void;
  onRemove: (email: string) => void;
}>) {
  const t = useTranslations('console');
  return (
    <div className="mt-1.5 overflow-hidden rounded-[12px] border border-(--bd-border)">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-(--bd-border) bg-(--bd-bg) px-4 py-2.5">
        <span className="font-semibold text-ink-900">
          {t('invite.people', { count: people.length })}
        </span>
        <span className="text-[12px] text-ink-500">{t('invite.names_hint')}</span>
      </div>
      <ul>
        {people.map((r) => (
          <li
            key={r.email}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 border-b border-(--bd-border-soft) px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_14rem_auto]"
          >
            <span className="truncate text-ink-900">{r.email}</span>
            <input
              type="text"
              className="bd-input col-span-2 row-start-2 md:col-span-1 md:col-start-2 md:row-start-1"
              value={r.name}
              onChange={(e) => onName(r.email, e.target.value)}
              placeholder={t('invite.name_placeholder')}
              aria-label={t('invite.name_label', { email: r.email })}
            />
            <button
              type="button"
              onClick={() => onRemove(r.email)}
              className="col-start-2 row-start-1 -mr-3 grid h-11 w-11 place-items-center rounded-lg text-ink-500 hover:bg-black/5 md:col-start-3"
              aria-label={t('invite.remove', { email: r.email })}
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
