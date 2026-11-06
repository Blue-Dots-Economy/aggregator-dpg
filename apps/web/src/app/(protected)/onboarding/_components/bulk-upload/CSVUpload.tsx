'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { I } from '@/icons';
import { useBulkUpload, useRecentBulkUploads } from '@/hooks/useOnboarding';
import { useProfileRaw } from '@/hooks/useProfile';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';
import { BulkUploadStartUnreadError } from '@/services/onboarding.service';
import type { BulkAttestationContent } from '@/lib/bulk-attestation.server';
import { AttestationCheckbox } from './AttestationCheckbox';
import { RECENT_UPLOADS_LIMIT } from './recent-uploads';
import { uploadErrorText } from './upload-error-text';
import { UploadFilePicker } from './UploadFilePicker';
import { UploadToast } from './UploadToast';

/** Delay before returning to the overview after a successful upload, so the toast is read. */
const RETURN_TO_OVERVIEW_DELAY_MS = 2500;

/** Props for {@link CSVUpload}. */
export interface CSVUploadProps {
  /**
   * Operator attestation text, loaded on the server.
   *
   * `null` shows a generic checkbox label. The checkbox must be ticked before
   * Upload is enabled; `attestation: true` is sent to `/start`.
   */
  attestation?: BulkAttestationContent | null;
}

/**
 * Bulk upload widget: template download, CSV picker, attestation and Upload.
 *
 * Uploads for the aggregator's participant type. Processing continues in the
 * worker; the recent uploads list shows its progress.
 */
export function CSVUpload({ attestation = null }: CSVUploadProps = {}) {
  const t = useTranslations('onboarding');
  const [attested, setAttested] = useState(false);
  const rawProfile = useProfileRaw();
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Participant type from the `aggregator_type` claim. Uses the network's first
  // domain while the profile loads; the API checks the type on upload.
  const participantType: string = rawProfile.data?.type ?? cfg.domains[0]?.id ?? '';
  // Plural label for the scoped domain, sourced from network config.
  const participantTypeLabel =
    cfg.domains.find((d) => d.id === participantType)?.plural_label ?? participantType;
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useBulkUpload();
  const recent = useRecentBulkUploads(RECENT_UPLOADS_LIMIT);
  const router = useRouter();

  const clearFile = () => {
    setPickedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const acceptFile = (f: File) => {
    if (!/\.csv$/i.test(f.name)) {
      // Tell the user how to fix it; uploading the .xlsx template directly is a
      // common mistake.
      setUploadError(
        /\.xlsx?$/i.test(f.name)
          ? 'This is an Excel file. Open it and use File → Save As (or Export) → CSV, then upload the .csv.'
          : 'Only .csv files are accepted.',
      );
      return;
    }
    setPickedFile(f);
    setUploadError(null);
    setUploadNotice(null);
  };

  const removeFile = () => {
    clearFile();
    setUploadError(null);
    setUploadNotice(null);
  };

  const onUpload = async () => {
    if (!pickedFile) return;
    setUploadError(null);
    setUploadNotice(null);
    try {
      const result = await upload.mutateAsync({
        file: pickedFile,
        participantType,
        attestation: true,
      });
      clearFile();
      if (result.duplicate) {
        setUploadNotice(
          result.message ?? 'This CSV was already uploaded earlier — showing the existing run.',
        );
        recent.refetch();
        return;
      }
      // Show the success note and refresh the list. Processing continues in the worker.
      setToast(t('csv.success_note'));
      recent.refetch();
      setTimeout(() => router.push('/onboarding'), RETURN_TO_OVERVIEW_DELAY_MS);
    } catch (err) {
      if (err instanceof BulkUploadStartUnreadError) {
        // The upload started: clear the file so it is not uploaded twice.
        clearFile();
        setUploadNotice(t('csv.start_unconfirmed'));
        recent.refetch();
        return;
      }
      setUploadError(uploadErrorText(err, t('csv.reply_unreadable')));
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
          {/* Aggregators have one participant type, so this is a read-only label. */}
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
          <button
            type="button"
            onClick={downloadTemplate}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary-600 hover:underline"
          >
            <I.download size={14} /> {t('csv.download_template_xlsx')}
          </button>
        </div>
      </div>

      <UploadFilePicker
        pickedFile={pickedFile}
        inputRef={fileInputRef}
        onFile={acceptFile}
        onClear={removeFile}
        participantType={participantType}
      />

      <AttestationCheckbox
        checked={attested}
        onChange={setAttested}
        attestation={attestation}
        fallbackLabel={t('csv.attestation_fallback')}
      />

      <div className="flex items-center justify-end mt-4">
        <Button onClick={onUpload} disabled={!pickedFile || upload.isPending || !attested}>
          {upload.isPending ? t('csv.uploading') : t('csv.upload_button')}
        </Button>
      </div>

      {uploadError && (
        <div className="mt-3 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2">
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
