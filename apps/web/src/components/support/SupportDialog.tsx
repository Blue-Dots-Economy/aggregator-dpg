'use client';
/**
 * Contact-support modal.
 *
 * Collects a complaint / support request: Name, Email, Phone (all prefilled
 * from the session where available and editable), a Type selector, a Details
 * textarea, and a required consent checkbox. Submit is blocked until Details
 * is non-empty, at least one contact channel is filled, and consent is
 * checked. POSTs to the BFF `POST /api/support` (which forwards to the
 * aggregator API's `POST /v1/support` and emails the configured support
 * address). Shows an inline success / unavailable (SUPPORT_EMAIL not
 * configured, 503) / error status rather than a toast — matches the rest of
 * the portal's inline-notice pattern (see `ConsentModal`). Dismissible via
 * the close button, overlay, or ESC.
 *
 * @module apps/web/src/components/support/SupportDialog
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { I } from '../../icons';
import { Button } from '../ui/Button';
import { useAuth } from '../../lib/auth-context';
import {
  SUPPORT_CONFIG_FALLBACK,
  encodeAttachments,
  formatBytes,
  validateAttachmentSelection,
  type SupportConfig,
} from '../../lib/support-attachments';

/** Props for {@link SupportDialog}. */
export interface SupportDialogProps {
  /** Whether the dialog is currently visible. */
  open: boolean;
  /** Callback fired when the dialog should be closed (sets open to false). */
  onOpenChange: (open: boolean) => void;
}

type Status =
  | 'idle'
  | 'sending'
  | 'success'
  | 'unavailable'
  | 'error'
  | 'invalid'
  | 'rate_limited'
  | 'attachment_rejected';
type SupportType = 'complaint' | 'support_request';

/**
 * Reads the API's `{ error: { code, detail } }` envelope from a failed
 * response, tolerating a non-JSON body (a proxy error page, say).
 *
 * @param res - The failed response.
 * @returns The error code and detail, or null when unreadable.
 */
async function readErrorCode(res: Response): Promise<{ code?: string; detail?: string } | null> {
  try {
    const body = (await res.json()) as { error?: { code?: string; detail?: string } };
    return body.error ?? null;
  } catch {
    return null;
  }
}

/**
 * Displays a modal contact-support form and relays submissions to the BFF.
 *
 * Returns null when `open` is false so the form state does not linger
 * between openings.
 *
 * @param props - Open state and change handler.
 * @returns The modal overlay element, or null when closed.
 */
export function SupportDialog({ open, onOpenChange }: SupportDialogProps): JSX.Element | null {
  const t = useTranslations('support');
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<SupportType>('complaint');
  const [details, setDetails] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [attachments, setAttachments] = useState<File[]>([]);
  /** Client-side attachment rejection, shown inline like the other notices. */
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /** Server-side attachment rejection message — it names the offending file. */
  const [serverDetail, setServerDetail] = useState<string | null>(null);
  const [config, setConfig] = useState<SupportConfig>(SUPPORT_CONFIG_FALLBACK);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Portal target only exists on the client; gate render until mounted so
  // the server pass (and first client paint) doesn't touch `document`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reset form state each time the dialog opens so re-opening starts fresh,
  // reseeding the prefill fields from the current session user.
  useEffect(() => {
    if (open) {
      setName(user?.name ?? '');
      setEmail(user?.email ?? '');
      setPhone(user?.phone ?? '');
      setType('complaint');
      setDetails('');
      setConsent(false);
      setStatus('idle');
      setAttachments([]);
      setAttachmentError(null);
      setServerDetail(null);
    }
  }, [open, user]);

  // Attachment limits come from the API, so the form validates against the same
  // numbers it enforces and an operator can raise them without a web rebuild.
  // A failed fetch leaves the defaults in place rather than blocking the form.
  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetch('/api/support/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SupportConfig | null) => {
        if (active && data) setConfig(data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [open]);

  // Dismiss on ESC, mirroring ConsentModal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open || !mounted) return null;

  const hasContact = email.trim() !== '' || phone.trim() !== '';
  const canSubmit = details.trim() !== '' && hasContact && consent;

  const attachedBytes = attachments.reduce((sum, file) => sum + file.size, 0);

  const onFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? []);
    // Clear either way, so re-picking the same file still fires onChange and a
    // rejected pick doesn't linger in the control.
    e.target.value = '';
    if (incoming.length === 0) return;

    const result = validateAttachmentSelection(attachments, incoming, config);
    if (!result.ok) {
      setAttachmentError(
        result.reason === 'count'
          ? t('attachment_too_many', { count: config.maxFiles })
          : result.reason === 'size'
            ? t('attachment_too_large', { size: formatBytes(config.maxTotalBytes) })
            : t('attachment_bad_type', { name: result.filename }),
      );
      return;
    }
    setAttachmentError(null);
    setAttachments(result.files);
  };

  const removeAttachment = (index: number) => {
    setAttachmentError(null);
    setAttachments((current) => current.filter((_, i) => i !== index));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      setStatus('invalid');
      return;
    }
    setStatus('sending');
    setServerDetail(null);
    try {
      // Encoded inside the sending state: a multi-MB file takes long enough
      // that the button must already be disabled.
      const encoded = attachments.length ? await encodeAttachments(attachments) : undefined;
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          type,
          details: details.trim(),
          consent: true,
          ...(encoded ? { attachments: encoded } : {}),
        }),
      });
      if (res.status === 201) {
        setStatus('success');
      } else if (res.status === 503) {
        setStatus('unavailable');
      } else if (res.status === 429) {
        setStatus('rate_limited');
      } else if (res.status === 413) {
        // The body limit, not the attachment check — a payload this far over the
        // cap never reaches the handler's specific codes.
        setAttachmentError(t('attachment_too_large', { size: formatBytes(config.maxTotalBytes) }));
        setStatus('idle');
      } else {
        // A server-side attachment rejection names the offending file, so it is
        // more useful than the generic failure line.
        const code = await readErrorCode(res);
        if (code?.code?.startsWith('ATTACHMENT_')) {
          setServerDetail(code.detail ?? null);
          setStatus('attachment_rejected');
        } else {
          setStatus('error');
        }
      }
    } catch {
      setStatus('error');
    }
  };

  const inputClass =
    'w-full rounded-[10px] border border-(--bd-border) px-3 py-2 text-[14px] bg-transparent';

  return createPortal(
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
    >
      {/* Invisible backdrop button captures click-outside-to-close (mirrors ConsentModal). */}
      <button
        type="button"
        aria-label={t('cancel')}
        className="absolute inset-0 cursor-default"
        onClick={() => onOpenChange(false)}
        tabIndex={-1}
      />
      <div className="relative z-10 w-full max-w-md rounded-[14px] bg-(--bd-card) border border-(--bd-border) p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[17px] font-semibold text-(--bd-fg)">{t('title')}</h2>
          <button
            type="button"
            aria-label={t('cancel')}
            onClick={() => onOpenChange(false)}
            className="text-(--bd-fg-muted) hover:text-(--bd-fg)"
          >
            <I.x size={18} />
          </button>
        </div>
        <p className="text-[13px] text-(--bd-fg-muted) mb-4">{t('description')}</p>

        {status === 'success' ? (
          <p className="text-[14px] text-emerald-600">{t('success')}</p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label htmlFor="support-name" className="block text-[13px] font-medium mb-1">
                {t('label_name')}
              </label>
              <input
                id="support-name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('placeholder_name')}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="support-email" className="block text-[13px] font-medium mb-1">
                {t('label_email')}
              </label>
              <input
                id="support-email"
                type="email"
                value={email}
                maxLength={320}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('placeholder_email')}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="support-phone" className="block text-[13px] font-medium mb-1">
                {t('label_phone')}
              </label>
              <input
                id="support-phone"
                type="tel"
                value={phone}
                maxLength={20}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t('placeholder_phone')}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="support-type" className="block text-[13px] font-medium mb-1">
                {t('label_type')}
              </label>
              <select
                id="support-type"
                value={type}
                onChange={(e) => setType(e.target.value as SupportType)}
                className={inputClass}
              >
                <option value="complaint">{t('type_complaint')}</option>
                <option value="support_request">{t('type_support_request')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="support-details" className="block text-[13px] font-medium mb-1">
                {t('label_details')}
              </label>
              <textarea
                id="support-details"
                value={details}
                required
                maxLength={5000}
                rows={5}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={t('placeholder_details')}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="support-attachments" className="block text-[13px] font-medium mb-1">
                {t('label_attachments')}
              </label>
              <p className="text-[12px] text-(--bd-fg-muted) mb-2">
                {t('attachments_hint', {
                  count: config.maxFiles,
                  size: formatBytes(config.maxTotalBytes),
                })}
              </p>
              <input
                ref={fileInputRef}
                id="support-attachments"
                type="file"
                multiple
                accept={config.allowedTypes.join(',')}
                onChange={onFilesSelected}
                disabled={status === 'sending' || attachments.length >= config.maxFiles}
                className="sr-only"
              />
              <Button
                kind="ghost"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={status === 'sending' || attachments.length >= config.maxFiles}
                className="text-[13px]"
              >
                {t('attachments_add')}
              </Button>
              {attachments.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {attachments.map((file, index) => (
                    <li
                      key={`${file.name}-${index}`}
                      className="flex items-center justify-between gap-2 rounded-[8px] border border-(--bd-border) px-2 py-1 text-[13px]"
                    >
                      <span className="truncate">{file.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-[12px] text-(--bd-fg-muted)">
                          {formatBytes(file.size)}
                        </span>
                        <button
                          type="button"
                          aria-label={t('attachments_remove', { name: file.name })}
                          onClick={() => removeAttachment(index)}
                          disabled={status === 'sending'}
                          className="text-(--bd-fg-muted) hover:text-(--bd-fg)"
                        >
                          <I.x size={14} />
                        </button>
                      </span>
                    </li>
                  ))}
                  <li className="text-[12px] text-(--bd-fg-muted)">
                    {t('attachments_total', {
                      used: formatBytes(attachedBytes),
                      total: formatBytes(config.maxTotalBytes),
                    })}
                  </li>
                </ul>
              )}
              {attachmentError && (
                <p className="mt-1 text-[13px] text-rose-600">{attachmentError}</p>
              )}
            </div>
            <label className="flex items-start gap-2 text-[13px] text-(--bd-fg)">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5"
                aria-label={t('consent_label')}
              />
              <span>{t('consent_label')}</span>
            </label>
            {status === 'invalid' && (
              <p className="text-[13px] text-rose-600">{t('validation_incomplete')}</p>
            )}
            {status === 'unavailable' && (
              <p className="text-[13px] text-amber-600">{t('unavailable')}</p>
            )}
            {status === 'rate_limited' && (
              <p className="text-[13px] text-amber-600">{t('rate_limited')}</p>
            )}
            {status === 'attachment_rejected' && (
              <p className="text-[13px] text-rose-600">{serverDetail ?? t('error')}</p>
            )}
            {status === 'error' && <p className="text-[13px] text-rose-600">{t('error')}</p>}
            <Button
              kind="primary"
              type="submit"
              disabled={status === 'sending' || !canSubmit}
              className="w-full justify-center py-2.5 text-[14px] font-semibold"
            >
              {status === 'sending' ? t('sending') : t('submit')}
            </Button>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
