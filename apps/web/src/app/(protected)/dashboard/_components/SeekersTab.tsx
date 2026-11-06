'use client';

/**
 * Dashboard for a profile domain such as seekers (`web` app).
 */
import { useTranslations } from 'next-intl';
import { toSeekerRow } from '../_lib/rows';
import { DomainTab } from './DomainTab';

/** Props for {@link SeekersTab}. */
export interface SeekersTabProps {
  /** The signed-in coordinator's own domain, from its `aggregator_type`. */
  domainId: string | undefined;
}

/** Participant-profile dashboard for any `profile_*` domain. */
export function SeekersTab({ domainId }: Readonly<SeekersTabProps>) {
  const t = useTranslations('dashboard');
  return (
    <DomainTab
      domainId={domainId}
      kind="seeker"
      toRow={toSeekerRow}
      icon="users"
      fallbackPlural={t('tabs.seekers')}
      activeFallbackLabel={(plural) => `${t('statuses.active')} ${plural}`}
    />
  );
}
