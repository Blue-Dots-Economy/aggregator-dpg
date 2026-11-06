'use client';

import { useTranslations } from 'next-intl';
import { useRecentBulkUploads } from '@/hooks/useOnboarding';
import { RECENT_UPLOADS_LIMIT } from './recent-uploads';
import { uploadErrorText } from './upload-error-text';
import { UploadRow } from './UploadRow';

/** Columns of the recent uploads table, for full-width message rows. */
const TABLE_COLUMNS = 8;

/**
 * "Recent uploads" table body, without an outer card.
 *
 * Render it inside a parent card.
 */
export function RecentUploadsBody() {
  const t = useTranslations('onboarding');
  const recent = useRecentBulkUploads(RECENT_UPLOADS_LIMIT);
  const items = recent.data?.items ?? [];
  const error = recent.error;
  const loading = recent.isLoading;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="font-display font-bold text-[14px] text-ink-700">
          {t('csv.recent.title')}
        </div>
        <span className="text-[12px] text-ink-400">
          {t('csv.recent.shown_count', { count: items.length })}
        </span>
      </div>
      <div className="overflow-auto scroll-x" style={{ maxHeight: 360 }}>
        <table className="bd-table" style={{ minWidth: 800 }}>
          <thead
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 2,
              background: 'var(--bd-table-head-bg)',
            }}
          >
            <tr>
              <th>{t('csv.recent.col_uploaded')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_type')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_status')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_total')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_passed')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_failed')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_skipped')}</th>
              <th style={{ minWidth: 240 }}>{t('csv.recent.col_reason')}</th>
            </tr>
          </thead>
          <tbody>
            {error && (
              <tr>
                <td colSpan={TABLE_COLUMNS} className="text-rose-600 text-[13px] py-6 text-center">
                  {uploadErrorText(error, t('csv.reply_unreadable'))}
                </td>
              </tr>
            )}
            {!error && items.length === 0 && !loading && (
              <tr>
                <td colSpan={TABLE_COLUMNS} className="text-ink-400 text-[13px] py-8 text-center">
                  {t('csv.recent.no_uploads')}
                </td>
              </tr>
            )}
            {items.map((it) => (
              <UploadRow key={it.upload_id} upload={it} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
