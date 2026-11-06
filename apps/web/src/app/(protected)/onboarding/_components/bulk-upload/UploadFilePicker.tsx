'use client';

import type { RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Dropzone } from '@/components/ui/Dropzone';
import { I } from '@/icons';

/** Bytes per kilobyte, for the file size shown on the chip. */
const BYTES_PER_KB = 1024;

/** Props for {@link UploadFilePicker}. */
export interface UploadFilePickerProps {
  /** The picked file, or `null` to show the drop prompt. */
  pickedFile: File | null;
  /** The hidden file input, so the parent can clear it after an upload. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Called with a file picked or dropped. */
  onFile: (file: File) => void;
  /** Called when the picked file is removed. */
  onClear: () => void;
  /** Participant type named in the hint. */
  participantType: string;
}

/**
 * Drop zone and file input for the bulk upload, showing the picked file as a chip.
 *
 * Takes the first file of a pick or a drop.
 */
export function UploadFilePicker({
  pickedFile,
  inputRef,
  onFile,
  onClear,
  participantType,
}: Readonly<UploadFilePickerProps>) {
  const t = useTranslations('onboarding');
  return (
    <Dropzone
      onFiles={(files) => {
        const f = files[0];
        if (f) onFile(f);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
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
              {(pickedFile.size / BYTES_PER_KB).toFixed(1)} KB
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClear();
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
  );
}
