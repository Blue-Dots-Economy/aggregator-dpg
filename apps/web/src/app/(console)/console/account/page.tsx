/**
 * My account (user & org Phase 5): the signed-in admin's contact, read-only
 * (contact change with OTP is deferred, P5-7).
 */

import { getTranslations } from 'next-intl/server';
import { getConsoleActor } from '@/lib/console-actor';
import { Topbar } from '@/components/shell/Topbar';
import { ConsoleSection, DetailList } from '@/components/console/ConsoleUi';

export default async function ConsoleAccountPage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const c = actor.me.user.contact;
  return (
    <>
      <Topbar title={t('account.heading')} subtitle={t('account.subtitle')} />
      <div className="flex flex-col gap-6">
        <ConsoleSection>
          <DetailList
            items={[
              { label: t('account.name'), value: c.name ?? '—' },
              { label: t('account.email'), value: c.email },
              { label: t('account.phone'), value: c.phone ?? '—' },
            ]}
          />
          <p className="mt-5 text-[13px] text-ink-500">{t('account.read_only')}</p>
        </ConsoleSection>
      </div>
    </>
  );
}
