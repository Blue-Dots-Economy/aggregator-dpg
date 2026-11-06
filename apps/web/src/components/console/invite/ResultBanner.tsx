/** The one-line result shown after the invite form sends. */

import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { I } from '@/icons';
import type { InviteResult } from './invite-recipients';

/** `existing[].status` and `invalid[].reason` values with their own wording. */
const KNOWN_REASONS = new Set([
  'active',
  'pending',
  'inactive',
  'retired',
  'invalid_email',
  'duplicate_in_batch',
  'store_error',
]);

/** The one-line result after a send: how many went out and why the rest did not. */
export function ResultBanner({
  result,
  onDismiss,
}: Readonly<{ result: InviteResult; onDismiss: () => void }>) {
  const t = useTranslations('console');
  const reasonText = (reason: string) =>
    t(`invite.reason.${KNOWN_REASONS.has(reason) ? reason : 'other'}`);
  return (
    <output className="flex items-start gap-3 rounded-[12px] bg-emerald-50 px-4 py-3 text-ink-700">
      <I.send size={16} className="mt-0.5 shrink-0 text-emerald-700" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-emerald-800">
          {t('invite.sent', { count: result.sent })}
        </span>
        {result.notSent.length ? (
          <span className="block break-words text-[13px] text-ink-500">
            {t('invite.not_sent')}{' '}
            {result.notSent.map((n) => `${n.email} (${reasonText(n.reason)})`).join(' · ')}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="-m-1 rounded-lg p-2 text-ink-500 hover:bg-black/5"
        aria-label={t('invite.dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </output>
  );
}
