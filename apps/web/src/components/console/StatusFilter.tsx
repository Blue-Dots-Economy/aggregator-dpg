'use client';

/**
 * A plain GET form that filters a console list by status. Works without
 * JavaScript; the page re-reads on the server.
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
    <form method="get" action={action} className="flex items-end gap-2 text-[13.5px]">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label className="flex flex-col gap-1">
        <span className="bd-label">{t('coordinators.status_filter')}</span>
        <select name="status" defaultValue={value} className="bd-input">
          <option value="">{t('coordinators.all')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" kind="ghost">
        OK
      </Button>
    </form>
  );
}
