/**
 * My account (user & org Phase 5): the signed-in admin's contact, read-only
 * (contact change with OTP is deferred, P5-7).
 */

import { getTranslations } from 'next-intl/server';
import { getConsoleActor } from '@/lib/console-actor';
import { Card } from '@/components/ui/Card';

export default async function ConsoleAccountPage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const c = actor.me.user.contact;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[22px] font-bold text-ink-900">{t('account.heading')}</h1>
      <Card className="p-4 text-[13.5px] flex flex-col gap-1">
        <span>
          {t('account.name')}: {c.name ?? '—'}
        </span>
        <span>
          {t('account.email')}: {c.email}
        </span>
        <span>
          {t('account.phone')}: {c.phone ?? '—'}
        </span>
      </Card>
      <p className="text-[13px] text-ink-600">{t('account.read_only')}</p>
    </div>
  );
}
