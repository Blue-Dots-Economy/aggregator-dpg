'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRecentBulkUploads, useRegistrationLinks } from '@/hooks/useOnboarding';
import { useProfileRaw } from '@/hooks/useProfile';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';
import { RecentUploadsBody } from './bulk-upload/RecentUploadsBody';
import { YourLinksBody } from './registration-links/YourLinksBody';
import { formatRelative } from './format-relative';
import { SummaryCard } from './SummaryCard';

/** Uploads the bulk upload card counts over. */
const SUMMARY_UPLOADS_LIMIT = 50;

/**
 * Summary card for bulk uploads, linking to /onboarding/bulk-uploads.
 *
 * Counts come from the recent uploads list.
 */
export function BulkUploadCard() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const recent = useRecentBulkUploads(SUMMARY_UPLOADS_LIMIT);
  const metrics = useMemo(() => {
    const items = recent.data?.items ?? [];
    let total = 0;
    let passed = 0;
    let failed = 0;
    let lastUploadAt: string | null = null;
    for (const it of items) {
      total += it.total_rows ?? 0;
      passed += it.passed ?? 0;
      failed += it.failed ?? 0;
      if (!lastUploadAt || it.created_at > lastUploadAt) lastUploadAt = it.created_at;
    }
    return { uploads: items.length, total, passed, failed, lastUploadAt };
  }, [recent.data]);

  return (
    <SummaryCard
      icon="upload"
      accent="primary"
      title={t('bulk_upload.title')}
      subtitle={t('bulk_upload.subtitle')}
      footnote={
        metrics.lastUploadAt
          ? t('bulk_upload.last_upload', { when: formatRelative(metrics.lastUploadAt) })
          : recent.isLoading
            ? t('bulk_upload.loading')
            : t('bulk_upload.no_uploads_yet')
      }
      metrics={[
        { label: t('bulk_upload.metrics.files_uploaded'), value: metrics.uploads, tone: 'ink' },
        { label: t('bulk_upload.metrics.rows'), value: metrics.total, tone: 'ink' },
        { label: t('bulk_upload.metrics.passed'), value: metrics.passed, tone: 'emerald' },
        { label: t('bulk_upload.metrics.failed'), value: metrics.failed, tone: 'rose' },
      ]}
      loading={recent.isLoading}
      ctaLabel={t('bulk_upload.cta')}
      onCta={() => router.push('/onboarding/bulk-uploads')}
      body={<RecentUploadsBody />}
    />
  );
}

/**
 * Summary card for registration links, linking to /onboarding/links.
 *
 * Counts come from the links list for the aggregator's type.
 */
export function RegistrationLinkCard() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const rawProfile = useProfileRaw();
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Use the network's first domain until the profile's type loads.
  const aggregatorType: string = rawProfile.data?.type ?? cfg.domains[0]?.id ?? '';
  const links = useRegistrationLinks(aggregatorType);
  const metrics = useMemo(() => {
    const items = links.data ?? [];
    let total = 0;
    let passed = 0;
    let active = 0;
    let lastCreatedAt: string | null = null;
    for (const l of items) {
      if (l.status === 'live') active += 1;
      total += l.metrics?.total ?? 0;
      passed += l.metrics?.passed ?? 0;
      if (!lastCreatedAt || l.created_at > lastCreatedAt) lastCreatedAt = l.created_at;
    }
    return { links: items.length, active, total, passed, lastCreatedAt };
  }, [links.data]);

  return (
    <SummaryCard
      icon="link"
      accent="amber"
      title={t('links.title')}
      subtitle={t('links.subtitle')}
      footnote={
        metrics.lastCreatedAt
          ? t('links.last_link', { when: formatRelative(metrics.lastCreatedAt) })
          : links.isLoading
            ? t('links.loading')
            : t('links.no_links_yet')
      }
      metrics={[
        { label: t('links.metrics.links'), value: metrics.links, tone: 'ink' },
        { label: t('links.metrics.active'), value: metrics.active, tone: 'emerald' },
        { label: t('links.metrics.registrations'), value: metrics.total, tone: 'ink' },
        { label: t('links.metrics.verified'), value: metrics.passed, tone: 'emerald' },
      ]}
      loading={links.isLoading}
      ctaLabel={t('links.cta')}
      onCta={() => router.push('/onboarding/links')}
      body={<YourLinksBody />}
    />
  );
}
