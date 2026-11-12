import type { JSX } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RegisterPageShell } from './RegisterPageShell';
import type { InviteReadFailure } from '../../../lib/invite-read.server';

/** Copy key for each reason an invite cannot be used. */
const MESSAGE_KEY: Readonly<Record<InviteReadFailure, string>> = {
  invalid: 'invite_invalid',
  expired: 'invite_expired',
  used: 'invite_used',
  org_inactive: 'invite_org_inactive',
  unavailable: 'invite_unavailable',
};

/**
 * Explains why an invite link cannot be used, with a sign-in link.
 *
 * @param props.reason - Why the invite read failed.
 * @returns The invite page body for an unusable link.
 */
export function InviteUnavailable({
  reason,
}: Readonly<{ reason: InviteReadFailure }>): JSX.Element {
  const t = useTranslations('register');
  return (
    <RegisterPageShell heading={t('invite_heading_invalid')}>
      <output className="mt-6 block rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13.5px] text-amber-800">
        {t(MESSAGE_KEY[reason])}{' '}
        <Link href="/login" className="font-semibold text-(--bd-primary-600) hover:underline">
          {t('invite_sign_in')}
        </Link>
      </output>
    </RegisterPageShell>
  );
}
