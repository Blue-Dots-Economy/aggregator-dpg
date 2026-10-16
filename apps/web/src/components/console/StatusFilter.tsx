'use client';

/**
 * A plain GET form filtering a console list by status (no JavaScript needed;
 * the page re-reads server-side).
 */

import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;

export function StatusFilter({
  action,
  value,
  hidden = {},
}: Readonly<{
  action: string;
  value: string;
  hidden?: Record<string, string>;
}>) {
  const t = useTranslations('console');
  return (
    <form method="get" action={action} className="flex items-center gap-2 text-[13.5px]">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-(--bd-fg-muted)">
          {t('coordinators.status_filter')}
        </span>
        <select name="status" defaultValue={value} className="bd-input min-w-[150px]">
          <option value="">{t('coordinators.all')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" kind="ghost">
        {t('coordinators.apply')}
      </Button>
    </form>
  );
}
