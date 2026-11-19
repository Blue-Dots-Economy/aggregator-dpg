'use client';

/**
 * Console notice shown after acting mode ended because the owner's
 * coordinator account can no longer be used (`?reason=acting_ended`).
 */

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ACTING_ENDED_REASON } from '@/lib/acting';

/** Renders the notice when the URL carries `reason=acting_ended`, else nothing. */
export function ActingEndedNotice() {
  const t = useTranslations('console');
  const reason = useSearchParams().get('reason');
  if (reason !== ACTING_ENDED_REASON) return null;
  return (
    <output className="mb-4 block rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-medium text-amber-900">
      {t('acting_ended')}
    </output>
  );
}
