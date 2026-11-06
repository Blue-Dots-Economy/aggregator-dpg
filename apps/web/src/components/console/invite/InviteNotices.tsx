/**
 * Small notices on the invite form: the count meter, the per-send limit note
 * and the invalid-address banner.
 */

import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { I } from '@/icons';
import { cn } from '@/lib/cn';

/** "N of max" with a small bar; amber once the list is full. */
export function CountMeter({ count, max }: Readonly<{ count: number; max: number }>) {
  const t = useTranslations('console');
  const full = count >= max;
  return (
    <span
      className={cn(
        'flex items-center gap-2 text-[12.5px] font-semibold tabular-nums',
        full ? 'text-amber-700' : 'text-ink-500',
      )}
    >
      {t('invite.count', { count, max })}
      <span aria-hidden className="h-[5px] w-20 overflow-hidden rounded-full bg-(--bd-bg)">
        <span
          className={cn(
            'block h-full rounded-full transition-[width]',
            full ? 'bg-amber-600' : 'bg-(--bd-primary)',
          )}
          style={{ width: `${Math.min(100, (count / max) * 100)}%` }}
        />
      </span>
    </span>
  );
}

/** Says that only `max` can be sent at a time, and how many emails were not added. */
export function LimitNote({ skipped, max }: Readonly<{ skipped: number; max: number }>) {
  const t = useTranslations('console');
  return (
    <output className="flex items-start gap-2.5 rounded-[10px] bg-(--bd-primary-50) px-3 py-2.5 text-[13px] text-(--bd-primary-600)">
      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {skipped
          ? t('invite.skipped_note', { max, count: skipped })
          : t('invite.limit_note', { max })}
      </span>
    </output>
  );
}

/** The count of invalid emails with a button that removes them all. */
export function InvalidBanner({
  count,
  onRemove,
}: Readonly<{ count: number; onRemove: () => void }>) {
  const t = useTranslations('console');
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] bg-rose-50 px-3 py-2.5 text-[13px] text-rose-700">
      <I.alert size={16} className="mt-0.5 shrink-0" />
      <span>{t('invite.invalid_count', { count })}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto whitespace-nowrap text-[12.5px] font-bold underline"
      >
        {t('invite.remove_invalid')}
      </button>
    </div>
  );
}
