/**
 * Console dashboard: a placeholder until the dashboards are built.
 */

import { getTranslations } from 'next-intl/server';
import { Topbar } from '@/components/shell/Topbar';
import { DashboardComingSoon } from '@/components/console/DashboardComingSoon';

export default async function ConsoleDashboardPage() {
  const t = await getTranslations('console');
  return (
    <>
      <Topbar title={t('dashboard.heading')} subtitle={t('dashboard.subtitle')} />
      <DashboardComingSoon />
    </>
  );
}
