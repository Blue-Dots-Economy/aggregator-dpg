/** The card header on the invite form: the organisation, or a picker when there are several. */

import { useTranslations } from 'next-intl';
import { I } from '@/icons';

/** The card header: the organisation (or a picker when there are several) and the role. */
export function OrgHeader({
  orgs,
  orgId,
  onChange,
}: Readonly<{
  orgs: Array<{ id: string; name: string }>;
  orgId: string;
  onChange: (id: string) => void;
}>) {
  const t = useTranslations('console');
  const single = orgs.length === 1 ? orgs[0] : null;
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-(--bd-border-soft) px-[22px] py-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-(--bd-primary-50) text-(--bd-primary-600)">
        <I.briefcase size={18} />
      </span>
      {single ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[12px] text-ink-500">{t('invite.inviting_to')}</span>
          <span className="break-words text-[15px] font-bold text-ink-900">{single.name}</span>
        </span>
      ) : (
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-500">{t('invite.org')}</span>
          <select className="bd-input" value={orgId} onChange={(e) => onChange(e.target.value)}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="ml-auto rounded-full bg-(--bd-bg) px-2.5 py-1 text-[12px] font-semibold text-ink-700">
        {t('invite.role')}
      </span>
    </header>
  );
}
