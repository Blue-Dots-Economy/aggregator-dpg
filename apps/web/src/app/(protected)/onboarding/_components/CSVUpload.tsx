'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useTranslations, useFormatter } from 'next-intl';
import { Button } from '../../../../components/ui/Button';
import { Dropzone } from '../../../../components/ui/Dropzone';
import { I } from '../../../../icons';
import { useBulkUpload, useRecentBulkUploads } from '../../../../hooks/useOnboarding';
import { useActiveDomain } from '../../../../hooks/useActiveDomain';
import { useRequestErrorText } from '@/hooks/useRequestErrorText';
import { useAggregatorConfig } from '@/hooks/useAggregatorConfig';
import { HttpError } from '@/services/http';
import { DomainSelect } from '../../../../components/ui/DomainSelect';
import type { BulkUploadStatus } from '../../../../services/onboarding.service';
import {
  BulkUploadEmptyError,
  BulkUploadStartUnreadError,
  BulkUploadTooLargeError,
  onboardingService,
} from '../../../../services/onboarding.service';
import type { BulkAttestationContent } from '../../../../lib/bulk-attestation.server';
import { useCan } from '../../../../lib/auth-context';
import { ResponseShapeError } from '@/lib/response-shape-error';
import { requestErrorCode, requestErrorFields } from '@/lib/request-errors';
import { bulkReasonText, bulkStatusText } from '@/lib/bulk-upload-text';
import {
  FieldMessage,
  useHandFieldErrors,
  type HandFieldError,
} from '@/components/forms/useHandFieldErrors';
import { useFieldErrorCopy } from '@/components/forms/useFieldErrors';
import { useRequestErrorMessage } from '@/components/forms/useRequestErrorMessage';

// Defined at module level so re-renders of CSVUpload do not remount the toast.
function UploadToast({ message, onDone }: { message: string; onDone: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const timer = setTimeout(onDone, 6000);
    return () => clearTimeout(timer);
  }, [onDone]);
  if (!mounted) return null;
  return createPortal(
    <output
      aria-live="polite"
      className="fixed top-4 left-4 right-4 sm:left-auto z-100 sm:max-w-sm rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 shadow-lg inline-flex items-start gap-2"
    >
      <I.check size={14} className="mt-0.5 shrink-0" /> <span>{message}</span>
    </output>,
    document.body,
  );
}

/** Props for {@link CSVUpload}. */
export interface CSVUploadProps {
  /**
   * Operator attestation text, loaded on the server.
   *
   * `null` shows a generic checkbox label. The checkbox must be ticked to
   * upload; `attestation: true` is sent to `/start`.
   */
  attestation?: BulkAttestationContent | null;
}

export function CSVUpload({ attestation = null }: CSVUploadProps = {}) {
  const t = useTranslations('onboarding');
  const tAccess = useTranslations('access');
  const aggregatorConfig = useAggregatorConfig();
  const [attested, setAttested] = useState(false);
  // Participant type: the active domain. Empty until the profile loads; the
  // API checks it against the domains the coordinator serves.
  const { domains: servedDomains, active, setActive } = useActiveDomain();
  const participantType = active ?? '';
  // Plural label for the active domain, sourced from network config.
  const participantTypeLabel =
    servedDomains.find((d) => d.id === participantType)?.plural_label ?? participantType;
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const copy = useFieldErrorCopy();
  const requestMessage = useRequestErrorMessage({
    DOMAIN_NOT_SERVED: tAccess('domain_not_served'),
    RATE_LIMITED: t('csv.rate_limited'),
    BULK_UPLOAD_NOT_READY: t('csv.error_not_ready'),
    STORAGE_UPLOAD_TOO_LARGE: t('csv.error_too_large'),
    STORAGE_UPLOAD_LINK_EXPIRED: t('csv.error_link_expired'),
    STORAGE_UPLOAD_FAILED: t('csv.error_storage'),
  });
  // `/start` names why a stored file was refused.
  const startReasonMessage: Readonly<Record<string, string>> = {
    upload_missing: t('csv.error_not_ready'),
    empty: t('csv.error_empty'),
    too_large: t('csv.error_too_large'),
  };
  const fe = useHandFieldErrors<'file' | 'attestation'>('csv-upload', {
    file: fileFieldError(fileError, pickedFile !== null, copy.required(t('csv.file_label'))),
    attestation: attested
      ? null
      : { kind: 'required', message: copy.required(t('csv.attestation_label')) },
  });
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useBulkUpload();
  const recent = useRecentBulkUploads(10);
  const router = useRouter();

  const acceptFile = (f: File) => {
    fe.touch('file');
    if (!/\.csv$/i.test(f.name)) {
      setPickedFile(null);
      setFileError(
        copy.invalid(/\.xlsx?$/i.test(f.name) ? t('csv.error_excel') : t('csv.error_not_csv')),
      );
      return;
    }
    setPickedFile(f);
    setFileError(null);
    setUploadError(null);
    setUploadNotice(null);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
  };

  const onDropFiles = (files: File[]) => {
    const f = files[0];
    if (f) acceptFile(f);
  };

  const onUpload = async () => {
    setUploadError(null);
    if (!fe.validate() || !pickedFile || !participantType) return;
    setUploadNotice(null);
    try {
      const result = await upload.mutateAsync({
        file: pickedFile,
        participantType,
        attestation: true,
        maxBytes: aggregatorConfig.data?.bulk_upload_max_bytes,
      });
      setPickedFile(null);
      fe.reset();
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (result.duplicate) {
        setUploadNotice(t('csv.duplicate_notice'));
        recent.refetch();
        return;
      }
      // Show the success note and refresh the list. Processing continues in the worker.
      setToast(t('csv.success_note'));
      recent.refetch();
      // Return to the onboarding overview after the toast has been shown.
      setTimeout(() => router.push('/onboarding'), 2500);
    } catch (err) {
      if (err instanceof BulkUploadStartUnreadError) {
        // The upload started: clear the file so it is not uploaded twice.
        setPickedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        setUploadNotice(t('csv.start_unconfirmed'));
        recent.refetch();
        return;
      }
      if (requestErrorCode(err) === 'CONSENT_REQUIRED') {
        setAttested(false);
        fe.validate();
        return;
      }
      if (err instanceof BulkUploadEmptyError) {
        setUploadError(t('csv.empty'));
        return;
      }
      if (err instanceof BulkUploadTooLargeError) {
        setUploadError(
          t('csv.too_large', { maxMb: Math.round((err.maxBytes / 1048576) * 10) / 10 }),
        );
        return;
      }
      setUploadError(
        uploadFailureText(err, startReasonMessage, t('csv.reply_unreadable'), (e) =>
          requestMessage(e, t('csv.upload_failed')),
        ),
      );
    }
  };

  const downloadTemplate = () => {
    // Offer only the workbook: it has dropdowns and required-column marks.
    // The API template endpoint still defaults to CSV.
    window.location.href = `/api/bulk-uploads/template?participant_type=${participantType}&format=xlsx`;
  };

  return (
    <div className="bd-card bd-shadow p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <div className="font-display font-bold text-[16px] text-ink-900">{t('csv.title')}</div>
          <div className="text-[12.5px] text-ink-400 mt-0.5">{t('csv.subtitle')}</div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {servedDomains.length > 1 ? (
            <DomainSelect domains={servedDomains} value={active} onChange={setActive} />
          ) : (
            // One participant type, so this is a read-only label.
            <div
              className="flex items-center bg-ink-50 border border-(--bd-border) rounded-[10px] p-0.5"
              aria-label={`Participant type: ${participantTypeLabel}`}
            >
              {participantTypeLabel && (
                <div className="px-3 py-1.5 rounded-[8px] text-[12.5px] font-semibold bg-white text-primary-600 bd-shadow select-none">
                  {participantTypeLabel}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={downloadTemplate}
            disabled={!participantType}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary-600 hover:underline"
          >
            <I.download size={14} /> {t('csv.download_template_xlsx')}
          </button>
        </div>
      </div>

      <fieldset
        {...fe.controlProps('file')}
        aria-label={t('csv.file_label')}
        tabIndex={-1}
        className="rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-(--bd-primary-100)"
      >
        <Dropzone onFiles={onDropFiles}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={onPick}
            className="hidden"
            id="csv-file-input"
          />
          {pickedFile ? (
            // Selected-file chip. Dismissing it also resets the input so the same
            // file can be picked again.
            <div className="flex items-center justify-center gap-2">
              <div className="inline-flex items-center gap-2 max-w-full px-3 py-2 rounded-[10px] bg-(--bd-primary-50) border border-(--bd-primary-100)">
                <I.upload size={14} className="text-primary-600 shrink-0" />
                <span className="text-[13.5px] font-semibold text-primary-700 truncate">
                  {pickedFile.name}
                </span>
                <span className="text-[11.5px] text-ink-400 shrink-0">
                  {(pickedFile.size / 1024).toFixed(1)} KB
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setPickedFile(null);
                    setFileError(null);
                    setUploadError(null);
                    setUploadNotice(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  title={t('csv.remove_file')}
                  aria-label={t('csv.remove_file')}
                  className="inline-flex items-center justify-center w-6 h-6 rounded-full text-ink-500 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0"
                >
                  <I.x size={13} />
                </button>
              </div>
            </div>
          ) : (
            <label htmlFor="csv-file-input" className="cursor-pointer block text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-white border border-(--bd-border) flex items-center justify-center text-primary-600 mb-3 bd-shadow">
                <I.upload size={20} />
              </div>
              <div className="text-[14px] font-semibold text-ink-700">
                {t('csv.drag_prompt')}{' '}
                <span className="text-primary-600 underline-offset-2">{t('csv.browse')}</span>
              </div>
              <div className="text-[12px] text-ink-400 mt-1">
                {t('csv.hint', { type: participantType })}
              </div>
            </label>
          )}
        </Dropzone>
      </fieldset>
      <FieldMessage id={fe.errorId('file')} message={fe.message('file')} />

      <label className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-(--bd-border) px-3.5 py-3 text-[13px] text-ink-800 cursor-pointer">
        <input
          type="checkbox"
          {...fe.controlProps('attestation')}
          checked={attested}
          onChange={(e) => setAttested(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-(--bd-border) accent-(--bd-primary-600)"
          aria-required
        />
        <span>{attestation ? attestation.content : t('csv.attestation_fallback')}</span>
      </label>
      <FieldMessage id={fe.errorId('attestation')} message={fe.message('attestation')} />

      <div className="flex items-center justify-end mt-4">
        <Button onClick={onUpload} disabled={upload.isPending}>
          {upload.isPending ? t('csv.uploading') : t('csv.upload_button')}
        </Button>
      </div>

      {uploadError && (
        <div
          role="alert"
          className="mt-3 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2"
        >
          {uploadError}
        </div>
      )}
      {uploadNotice && (
        <div className="mt-3 text-[12.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-[10px] px-3 py-2">
          {uploadNotice}
        </div>
      )}
      {toast && <UploadToast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/**
 * "Recent uploads" table body, without an outer card.
 *
 * Render it inside a parent card.
 */
export function RecentUploadsBody() {
  const t = useTranslations('onboarding');
  const requestErrorText = useRequestErrorText();
  const recent = useRecentBulkUploads(10);
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
                <td colSpan={8} className="text-rose-600 text-[13px] py-6 text-center">
                  {uploadErrorText(
                    error,
                    t('csv.reply_unreadable'),
                    requestErrorText(error, t('csv.recent.load_failed')),
                  )}
                </td>
              </tr>
            )}
            {!error && items.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="text-ink-400 text-[13px] py-8 text-center">
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

function UploadRow({ upload }: { upload: BulkUploadStatus }) {
  const t = useTranslations('onboarding');
  const format = useFormatter();
  const can = useCan();
  const tRecent = useTranslations('onboarding.csv.recent');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const onDownloadErrors = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await onboardingService.errorsCsvUrl(upload.upload_id);
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.warn('errors download failed', err);
      setDownloadError(
        err instanceof HttpError && err.status === 404
          ? t('csv.recent.errors_unavailable')
          : t('csv.recent.errors_download_failed'),
      );
    } finally {
      setDownloading(false);
    }
  };

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
        <UploadStatusBadge status={upload.status} label={bulkStatusText(upload.status, tRecent)} />
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
      <td className="text-[12px]">
        <UploadErrorsCell
          upload={upload}
          canDownload={can('profiles.view_pii')}
          downloading={downloading}
          downloadError={downloadError}
          onDownload={onDownloadErrors}
        />
      </td>
    </tr>
  );
}

/**
 * Text to show for a failed upload call. Never the error's own message, which
 * can hold a response body.
 *
 * @param err - The failure.
 * @param unreadable - The message for a reply that could not be read.
 * @param otherwise - The message for any other failure.
 * @returns `unreadable` for an unreadable reply, else `otherwise`.
 */
function uploadErrorText(err: unknown, unreadable: string, otherwise: string): string {
  return err instanceof ResponseShapeError ? unreadable : otherwise;
}

/** Props for {@link UploadErrorsCell}. */
interface UploadErrorsCellProps {
  upload: BulkUploadStatus;
  /** The report carries submitted contact data, so only PII Access may download it. */
  canDownload: boolean;
  downloading: boolean;
  downloadError: string | null;
  onDownload: () => void;
}

/** The "Reason / errors" cell of an upload row. */
function UploadErrorsCell({
  upload,
  canDownload,
  downloading,
  downloadError,
  onDownload,
}: Readonly<UploadErrorsCellProps>) {
  const t = useTranslations('onboarding');
  const tRecent = useTranslations('onboarding.csv.recent');
  const none = <span className="text-ink-300">—</span>;
  if (upload.status === 'completed' && upload.failed > 0 && upload.errors_csv_s3_key) {
    if (!canDownload) return none;
    return (
      <>
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-(--bd-primary-50) text-primary-600 font-semibold hover:bg-(--bd-primary-100) disabled:opacity-60"
        >
          <I.download size={12} />
          {downloading ? t('csv.recent.signing') : 'errors.csv'}
        </button>
        {downloadError ? (
          <span role="alert" className="mt-1 block whitespace-normal text-rose-600 max-w-[240px]">
            {downloadError}
          </span>
        ) : null}
      </>
    );
  }
  if (upload.status === 'completed') {
    return <span className="text-emerald-600">{t('csv.recent.all_rows_passed')}</span>;
  }
  if (!upload.status_reason) return none;
  return (
    <span className="text-rose-600 block whitespace-normal wrap-break-word max-w-[240px] align-middle leading-snug">
      {bulkReasonText(upload.status_reason, tRecent)}
    </span>
  );
}

/** The message for a failed upload: an unreadable reply, a refused file, else the request's own message. */
function uploadFailureText(
  err: unknown,
  byReason: Readonly<Record<string, string>>,
  unreadable: string,
  requestMessage: (err: unknown) => string,
): string {
  if (err instanceof ResponseShapeError) return unreadable;
  const reason = requestErrorFields(err)?.['reason'];
  if (typeof reason === 'string' && Object.hasOwn(byReason, reason))
    return byReason[reason] ?? unreadable;
  return requestMessage(err);
}

/** The file box's error: a refused file, else "required" until one is picked. */
function fileFieldError(
  refused: string | null,
  picked: boolean,
  requiredMessage: string,
): HandFieldError | null {
  if (refused) return { kind: 'invalid', message: refused };
  return picked ? null : { kind: 'required', message: requiredMessage };
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function UploadStatusBadge({ status, label }: Readonly<{ status: string; label: string }>) {
  const map: Record<string, { bg: string; tone: string }> = {
    pending: { bg: 'bg-ink-50', tone: 'text-ink-600' },
    uploaded: { bg: 'bg-sky-50', tone: 'text-sky-700' },
    file_validating: { bg: 'bg-amber-50', tone: 'text-amber-700' },
    file_failed: { bg: 'bg-rose-50', tone: 'text-rose-700' },
    row_processing: { bg: 'bg-amber-50', tone: 'text-amber-700' },
    finalising: { bg: 'bg-amber-50', tone: 'text-amber-700' },
    completed: { bg: 'bg-emerald-50', tone: 'text-emerald-700' },
    failed: { bg: 'bg-rose-50', tone: 'text-rose-700' },
  };
  const cfg = map[status] ?? { bg: 'bg-ink-50', tone: 'text-ink-600' };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-[11.5px] ${cfg.bg} ${cfg.tone}`}
    >
      {label}
    </span>
  );
}
