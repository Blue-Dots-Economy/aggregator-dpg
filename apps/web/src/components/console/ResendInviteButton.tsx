'use client';

/**
 * Sends an expired invite again from a console list, through the same invite route the
 * Invite pages use.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserInviteResponseSchema } from '@aggregator-dpg/shared-primitives/user-org';
import { sendConsole } from '../../lib/console-client';
import { cn } from '../../lib/cn';

type Phase = 'idle' | 'sending' | 'sent' | 'failed';

export function ResendInviteButton({
  kind,
  orgId,
  email,
}: Readonly<{
  /** `user` re-invites into `orgId`; `org` re-invites an organisation under `orgId`. */
  kind: 'user' | 'org';
  orgId: string;
  email: string;
}>) {
  const t = useTranslations('console.open_invites');
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');

  async function resend() {
    setPhase('sending');
    const body =
      kind === 'user'
        ? { org_id: orgId, recipients: [{ email }] }
        : { parent_id: orgId, recipients: [{ email }] };
    const r = await sendConsole(
      `/api/console/${kind}/invite`,
      'POST',
      UserInviteResponseSchema,
      body,
    );
    if (!r.ok) {
      setPhase('failed');
      return;
    }
    setPhase('sent');
    router.refresh();
  }

  if (phase === 'sent') {
    return <span className="text-[12.5px] font-semibold text-emerald-700">{t('resent')}</span>;
  }
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={resend}
        disabled={phase === 'sending'}
        aria-label={t('resend_named', { email })}
        className={cn(
          'rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-(--bd-primary-600) hover:bg-(--bd-primary-50)',
          phase === 'sending' && 'opacity-60',
        )}
      >
        {t('resend')}
      </button>
      {phase === 'failed' ? (
        <span role="alert" className="text-[12px] text-rose-700">
          {t('resend_failed')}
        </span>
      ) : null}
    </span>
  );
}
