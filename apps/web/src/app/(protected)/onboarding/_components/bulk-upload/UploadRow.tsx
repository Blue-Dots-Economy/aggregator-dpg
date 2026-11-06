'use client';

import { useState } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import { I } from '@/icons';
import type { BulkUploadStatus } from '@/services/onboarding.service';
import { onboardingService } from '@/services/onboarding.service';
import { useCan } from '@/lib/auth-context';
import { formatRelative } from '../format-relative';
import { UploadStatusBadge } from './UploadStatusBadge';

/** One row of the recent uploads table. */
export function UploadRow({ upload }: Readonly<{ upload: BulkUploadStatus }>) {
  const t = useTranslations('onboarding');
  const format = useFormatter();
  const can = useCan();
  const [downloading, setDownloading] = useState(false);

  const onDownloadErrors = async () => {
    setDownloading(true);
    try {
      const res = await onboardingService.errorsCsvUrl(upload.upload_id);
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.warn('errors download failed', err);
    } finally {
      setDownloading(false);
    }
  };

  let reason;
  if (upload.status === 'completed' && upload.failed > 0 && upload.errors_csv_s3_key) {
    // The report carries submitted contact data: PII Access only.
    reason = can('profiles.view_pii') ? (
      <button
        type="button"
        onClick={onDownloadErrors}
        disabled={downloading}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-(--bd-primary-50) text-primary-600 font-semibold hover:bg-(--bd-primary-100) disabled:opacity-60"
      >
        <I.download size={12} />
        {downloading ? t('csv.recent.signing') : 'errors.csv'}
      </button>
    ) : (
      <span className="text-ink-300">—</span>
    );
  } else if (upload.status === 'completed') {
    reason = <span className="text-emerald-600">{t('csv.recent.all_rows_passed')}</span>;
  } else if (upload.status_reason) {
    reason = (
      <span
        title={upload.status_reason}
        className="text-rose-600 block whitespace-pre-line wrap-break-word max-w-[240px] align-middle leading-snug"
      >
        {upload.status_reason.replace(/,\s*/g, ',\n')}
      </span>
    );
  } else {
    reason = <span className="text-ink-300">—</span>;
  }

  return (
    <tr>
      <td className="text-[12.5px] text-ink-700 whitespace-nowrap">
        <div className="font-semibold">{formatRelative(upload.created_at)}</div>
        <div className="text-[11px] text-ink-400">
          {format.dateTime(new Date(upload.created_at), {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      </td>
      <td style={{ textAlign: 'center' }}>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-[11.5px] ${
            upload.participant_type === 'seeker'
              ? 'bg-amber-50 text-amber-700'
              : 'bg-sky-50 text-sky-700'
          }`}
        >
          {upload.participant_type}
        </span>
      </td>
      <td style={{ textAlign: 'center' }}>
        <UploadStatusBadge status={upload.status} />
      </td>
      <td style={{ textAlign: 'center' }} className="tabular-nums font-semibold">
        {upload.total_rows ?? '—'}
      </td>
      <td style={{ textAlign: 'center' }} className="tabular-nums text-emerald-600 font-semibold">
        {upload.passed}
      </td>
      <td style={{ textAlign: 'center' }} className="tabular-nums text-rose-600 font-semibold">
        {upload.failed}
      </td>
      <td style={{ textAlign: 'center' }} className="tabular-nums text-amber-700 font-semibold">
        {upload.skipped}
      </td>
      <td className="text-[12px]">{reason}</td>
    </tr>
  );
}
