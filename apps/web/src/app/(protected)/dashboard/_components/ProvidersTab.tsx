'use client';

/**
 * Dashboard for a job-posting domain such as providers (`web` app).
 */
import { useTranslations } from 'next-intl';
import { toProviderRow } from '../_lib/rows';
import { DomainTab } from './DomainTab';

/** Props for {@link ProvidersTab}. */
export interface ProvidersTabProps {
  /** The signed-in coordinator's own domain, from its `aggregator_type`. */
  domainId: string | undefined;
}

/** Provider dashboard for a domain whose `item_type` is a job posting. */
export function ProvidersTab({ domainId }: Readonly<ProvidersTabProps>) {
  const t = useTranslations('dashboard');
  return (
    <DomainTab
      domainId={domainId}
      kind="provider"
      toRow={toProviderRow}
      icon="briefcase"
      fallbackPlural={t('tabs.providers')}
      activeFallbackLabel={() => t('statuses.active')}
    />
  );
}
