'use client';

import type { JSX } from 'react';
import { useTranslations } from 'next-intl';
import { CSVUpload } from './CSVUpload';
import { OnboardingSubpage } from './OnboardingSubpage';
import type { BulkAttestationContent } from '../../../../lib/bulk-attestation.server';

/** Props for {@link BulkUploadsClient}. */
export interface BulkUploadsClientProps {
  /** Operator attestation copy shown before upload; null → generic label. */
  attestation: BulkAttestationContent | null;
}

/**
 * Client body of the bulk-uploads page.
 *
 * Passes the server-loaded attestation text to {@link CSVUpload}.
 */
export function BulkUploadsClient({ attestation }: BulkUploadsClientProps): JSX.Element {
  const t = useTranslations('onboarding');
  return (
    <OnboardingSubpage
      title={t('bulk_uploads_page.title')}
      subtitle={t('bulk_uploads_page.subtitle')}
      backLabel={t('bulk_uploads_page.back')}
    >
      <CSVUpload attestation={attestation} />
    </OnboardingSubpage>
  );
}
