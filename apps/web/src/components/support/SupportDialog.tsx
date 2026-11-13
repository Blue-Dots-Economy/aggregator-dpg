'use client';
/**
 * Contact-support modal.
 *
 * Collects a support request: Name, Email, Phone (prefilled from the session
 * and editable), Type, Details, and a required consent checkbox. A Submit
 * with a missing or wrong field shows the message under that field. Posts to
 * `POST /api/support`. Shows success, unavailable (503), or error inline.
 * Closes on the close button, overlay click, or ESC.
 *
 * @module apps/web/src/components/support/SupportDialog
 */
import { useEffect, useRef, useState, type ChangeEvent, type SubmitEvent, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { I } from '../../icons';
import { Button } from '../ui/Button';
import { isEmailAddress } from '@aggregator-dpg/shared-primitives/phone';
import { useAuth } from '../../lib/auth-context';
import { z } from 'zod';
import { readApiError, type ApiError } from '@/lib/api-error';
import { FieldMessage, useHandFieldErrors, type HandFieldError } from '../forms/useHandFieldErrors';
import { PhoneInput } from '../forms/PhoneInput';
import { isAcceptedPhone } from '@/lib/phone';
import { useFieldErrorCopy } from '../forms/useFieldErrors';
import {
  encodeAttachments,
  formatBytes,
  pickerAccept,
  validateAttachmentSelection,
  type AttachmentRejection,
  type SupportConfig,
} from '../../lib/support-attachments';
import { withStableKeys } from '@/lib/list-keys';
import { useSupportConfig } from '@/hooks/useSupportConfig';
import { useIsClient } from '@/hooks/useIsClient';
import { SelectField } from '@/components/ui/SelectField';

/** Props for {@link SupportDialog}. */
export interface SupportDialogProps {
  /** Whether the dialog is currently visible. */
  open: boolean;
  /** Called when the dialog should close. */
  onOpenChange: (open: boolean) => void;
}

type Status =
  'idle' | 'sending' | 'success' | 'unavailable' | 'error' | 'rate_limited' | 'attachment_rejected';
const SUPPORT_TYPES = ['complaint', 'support_request'] as const;
type SupportType = (typeof SUPPORT_TYPES)[number];

/** Narrows a picked value to a request type the API accepts. */
function isSupportType(value: string): value is SupportType {
  return SUPPORT_TYPES.some((type) => type === value);
}

type SupportField = 'name' | 'email' | 'phone' | 'details' | 'consent';
const SUPPORT_FIELDS: ReadonlySet<string> = new Set<SupportField>([
  'name',
  'email',
  'phone',
  'details',
  'consent',
]);

function isSupportField(key: unknown): key is SupportField {
  return typeof key === 'string' && SUPPORT_FIELDS.has(key);
}

/** A `400 SCHEMA_VALIDATION`'s issues, as far as they name a field. */
const IssuesSchema = z.object({
  issues: z
    .array(
      z.object({
        instancePath: z.string().optional().catch(undefined),
        path: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .catch(undefined),
      }),
    )
    .catch([]),
});

/** Form fields named by a `400 SCHEMA_VALIDATION`'s issues. */
function rejectedFields(error: ApiError | null): SupportField[] {
  const parsed = IssuesSchema.safeParse(error?.fields ?? {});
  const out = new Set<SupportField>();
  for (const issue of parsed.success ? parsed.data.issues : []) {
    const first = issue.path?.[0] ?? (issue.instancePath ?? '').split('/').find(Boolean);
    if (isSupportField(first)) out.add(first);
  }
  return [...out];
}

/** What the dialog should show after a submit response. */
interface SubmitOutcome {
  status: Status;
  /** Set to replace the inline attachment message; left undefined to keep it. */
  attachmentError?: string;
  /** Set to carry the API's own rejection detail (it names the file). */
  serverDetail?: string | null;
  /** Fields the API rejected. */
  rejected?: SupportField[];
}

/**
 * Maps a submit response to what the dialog shows. Each failure keeps its own
 * message.
 *
 * @param res - The response from `POST /api/support`.
 * @param t - The `support` namespace translator.
 * @param config - Limits currently served by the API.
 * @returns The status plus any message to display with it.
 */
async function resolveSubmitOutcome(
  res: Response,
  t: (key: string, values?: Record<string, string | number>) => string,
  config: SupportConfig,
): Promise<SubmitOutcome> {
  if (res.status === 201) return { status: 'success' };
  if (res.status === 503) return { status: 'unavailable' };
  if (res.status === 429) return { status: 'rate_limited' };
  if (res.status === 413) {
    // Request body over the size limit; the handler never saw it.
    return {
      status: 'idle',
      attachmentError: t('attachment_too_large', { size: formatBytes(config.maxTotalBytes) }),
    };
  }
  // A server-side attachment rejection names the file, so show it.
  const error = await readApiError(res);
  if (error?.code?.startsWith('ATTACHMENT_')) {
    return { status: 'attachment_rejected', serverDetail: error.detail ?? null };
  }
  const rejected = rejectedFields(error);
  if (rejected.length > 0) return { status: 'idle', rejected };
  return { status: 'error' };
}

/**
 * Translates a client-side attachment rejection into the inline message shown
 * under the picker.
 *
 * @param rejection - The failed selection result.
 * @param t - The `support` namespace translator.
 * @param config - Limits currently served by the API.
 * @returns The translated message.
 */
function rejectionMessage(
  rejection: AttachmentRejection,
  t: (key: string, values?: Record<string, string | number>) => string,
  config: SupportConfig,
): string {
  if (rejection.reason === 'count') return t('attachment_too_many', { count: config.maxFiles });
  if (rejection.reason === 'size') {
    return t('attachment_too_large', { size: formatBytes(config.maxTotalBytes) });
  }
  return t('attachment_bad_type', { name: rejection.filename });
}

/** Identifies a picked file by its name, size and modification time. */
function attachmentKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Displays a modal contact-support form and relays submissions to the BFF.
 *
 * Returns null when `open` is false. The form mounts on each opening, so its
 * state starts again from the session user.
 *
 * @param props - Open state and change handler.
 * @returns The modal overlay element, or null when closed.
 */
export function SupportDialog({ open, onOpenChange }: SupportDialogProps): JSX.Element | null {
  // Render the portal only on the client, since `document` is client-only.
  const isClient = useIsClient();
  if (!open || !isClient) return null;
  return <SupportForm onOpenChange={onOpenChange} />;
}

/** The open dialog: form state, submit and the portal. */
function SupportForm({
  onOpenChange,
}: Readonly<Pick<SupportDialogProps, 'onOpenChange'>>): JSX.Element {
  const t = useTranslations('support');
  const tForm = useTranslations('form');
  const { user } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [type, setType] = useState<SupportType>('complaint');
  const [details, setDetails] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [attachments, setAttachments] = useState<File[]>([]);
  /** Client-side attachment rejection, shown inline like the other notices. */
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /** Server-side attachment rejection message; it names the file. */
  const [serverDetail, setServerDetail] = useState<string | null>(null);
  // Attachment limits come from the API. If the read fails, defaults stay.
  const config = useSupportConfig();
  const copy = useFieldErrorCopy();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dismiss on ESC.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpenChange]);

  const hasContact = email.trim() !== '' || phone.trim() !== '';
  const req = (ok: boolean, label: string): HandFieldError | null =>
    ok ? null : { kind: 'required', message: copy.required(label) };
  /** Email error: a contact is needed, and a typed email must look like one. */
  const emailFieldError = (): HandFieldError | null => {
    if (!hasContact) return { kind: 'required', message: t('error_contact_required') };
    const typed = email.trim();
    if (typed && !isEmailAddress(typed.toLowerCase())) {
      return { kind: 'invalid', message: copy.invalid(t('error_email_invalid')) };
    }
    return null;
  };
  const fieldErrors: Partial<Record<SupportField, HandFieldError | null>> = {
    name: req(name.trim() !== '', t('label_name')),
    email: emailFieldError(),
    phone:
      phone.trim() && !isAcceptedPhone(phone.trim())
        ? { kind: 'invalid', message: copy.invalid(t('error_phone_invalid')) }
        : null,
    details: req(details.trim() !== '', t('label_details')),
    consent: req(consent, t('consent_short')),
  };
  const fe = useHandFieldErrors<SupportField>('support', fieldErrors);
  const fieldLabel: Record<SupportField, string> = {
    name: t('label_name'),
    email: t('label_email'),
    phone: t('label_phone'),
    details: t('label_details'),
    consent: t('consent_short'),
  };
  /** Props for a control, clearing its server message once edited. */
  const ctl = (key: SupportField) => fe.controlProps(key);
  const edited = (key: SupportField) => fe.clearServer(key);

  const attachedBytes = attachments.reduce((sum, file) => sum + file.size, 0);

  const onFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? []);
    // Clear the input so picking the same file again fires onChange.
    e.target.value = '';
    if (incoming.length === 0) return;

    const result = validateAttachmentSelection(attachments, incoming, config);
    if (!result.ok) {
      setAttachmentError(rejectionMessage(result, t, config));
      return;
    }
    setAttachmentError(null);
    setAttachments(result.files);
  };

  const removeAttachment = (index: number) => {
    setAttachmentError(null);
    setAttachments((current) => current.filter((_, i) => i !== index));
  };

  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!fe.validate()) return;
    setStatus('sending');
    setServerDetail(null);
    try {
      // Encoding counts as sending, so the button is disabled during it.
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
      const outcome = await resolveSubmitOutcome(res, t, config);
      if (outcome.attachmentError !== undefined) setAttachmentError(outcome.attachmentError);
      if (outcome.serverDetail !== undefined) setServerDetail(outcome.serverDetail);
      if (outcome.rejected) {
        fe.setServerErrors(
          Object.fromEntries(
            outcome.rejected.map((k) => [
              k,
              copy.invalid(tForm('error_value_rejected', { label: fieldLabel[k] })),
            ]),
          ),
        );
      }
      setStatus(outcome.status);
    } catch {
      setStatus('error');
    }
  };

  const inputClass =
    // 16px below `sm` so iOS Safari does not zoom on focus.
    'w-full rounded-[10px] border border-(--bd-border) px-3 py-2 text-[16px] sm:text-[14px] bg-transparent';

  return createPortal(
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
    >
      {/* Invisible backdrop button: click outside to close. */}
      <button
        type="button"
        aria-label={t('cancel')}
        className="absolute inset-0 cursor-default"
        onClick={() => onOpenChange(false)}
        tabIndex={-1}
      />
      <div className="relative z-10 w-full max-w-md rounded-[14px] bg-(--bd-card) border border-(--bd-border) p-5 max-h-[90dvh] overflow-y-auto">
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
          <form onSubmit={submit} noValidate className="space-y-3">
            <div>
              <label htmlFor="support-name" className="block text-[13px] font-medium mb-1">
                {t('label_name')}
              </label>
              <input
                {...ctl('name')}
                value={name}
                maxLength={200}
                onChange={(e) => {
                  setName(e.target.value);
                  edited('name');
                }}
                placeholder={t('placeholder_name')}
                className={inputClass}
              />
              <FieldMessage id={fe.errorId('name')} message={fe.message('name')} />
            </div>
            <div>
              <label htmlFor="support-email" className="block text-[13px] font-medium mb-1">
                {t('label_email')}
              </label>
              <input
                {...ctl('email')}
                type="email"
                value={email}
                maxLength={320}
                onChange={(e) => {
                  setEmail(e.target.value);
                  edited('email');
                }}
                placeholder={t('placeholder_email')}
                className={inputClass}
              />
              <FieldMessage id={fe.errorId('email')} message={fe.message('email')} />
            </div>
            <div>
              <label htmlFor="support-phone" className="block text-[13px] font-medium mb-1">
                {t('label_phone')}
              </label>
              <PhoneInput
                id={ctl('phone').id}
                value={phone}
                onChange={(next) => {
                  setPhone(next ?? '');
                  edited('phone');
                }}
                onBlur={ctl('phone').onBlur}
                inputProps={ctl('phone')}
              />
              <FieldMessage id={fe.errorId('phone')} message={fe.message('phone')} />
            </div>
            <div>
              <label htmlFor="support-type" className="block text-[13px] font-medium mb-1">
                {t('label_type')}
              </label>
              <SelectField
                id="support-type"
                value={type}
                onChange={(v) => {
                  if (isSupportType(v)) setType(v);
                }}
                options={[
                  { value: 'complaint', label: t('type_complaint') },
                  { value: 'support_request', label: t('type_support_request') },
                ]}
              />
            </div>
            <div>
              <label htmlFor="support-details" className="block text-[13px] font-medium mb-1">
                {t('label_details')}
              </label>
              <textarea
                {...ctl('details')}
                value={details}
                required
                maxLength={5000}
                rows={5}
                onChange={(e) => {
                  setDetails(e.target.value);
                  edited('details');
                }}
                placeholder={t('placeholder_details')}
                className={inputClass}
              />
              <FieldMessage id={fe.errorId('details')} message={fe.message('details')} />
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
                accept={pickerAccept(config)}
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
                  {withStableKeys(attachments, attachmentKey).map(({ item: file, key }, index) => (
                    <li
                      key={key}
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
                <p className="mt-1 text-[11.5px] text-red-500">{attachmentError}</p>
              )}
            </div>
            <div>
              <label className="flex items-start gap-2 text-[13px] text-(--bd-fg)">
                <input
                  type="checkbox"
                  {...ctl('consent')}
                  checked={consent}
                  onChange={(e) => {
                    setConsent(e.target.checked);
                    edited('consent');
                  }}
                  className="mt-0.5"
                  aria-label={t('consent_label')}
                />
                <span>{t('consent_label')}</span>
              </label>
              <FieldMessage id={fe.errorId('consent')} message={fe.message('consent')} />
            </div>
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
              disabled={status === 'sending'}
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
