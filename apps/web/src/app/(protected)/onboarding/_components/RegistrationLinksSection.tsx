'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations, useFormatter } from 'next-intl';
import { Button } from '../../../../components/ui/Button';
import {
  FieldMessage,
  useHandFieldErrors,
  type HandControlProps,
  type HandFieldError,
} from '@/components/forms/useHandFieldErrors';
import { useFieldErrorCopy } from '@/components/forms/useFieldErrors';
import { useRequestErrorMessage } from '@/components/forms/useRequestErrorMessage';
import { I } from '../../../../icons';
import {
  useActivateLink,
  useCreateLink,
  useDeactivateLink,
  useRegistrationLinks,
  useUpdateLink,
} from '../../../../hooks/useOnboarding';
import { useProfile, useProfileRaw } from '../../../../hooks/useProfile';
import { useAggregatorConfig } from '../../../../hooks/useAggregatorConfig';
import { useIsClient } from '@/hooks/useIsClient';
import { useActiveDomain } from '@/hooks/useActiveDomain';
import { useRequestErrorText } from '@/hooks/useRequestErrorText';
import { DomainSelect } from '@/components/ui/DomainSelect';
import type { ApiRegistrationLink } from '../../../../services/onboarding.service';
import { SelectField } from '@/components/ui/SelectField';

interface CreateLinkFormState {
  /** Domain id from the network config (e.g. `seeker`), set to the aggregator's registered type. */
  domain: string;
  /** Instance (state of operation). Drives slug + display title. */
  state: string;
  /** District. Required. Drives slug + display title. */
  district: string;
  /** Free-form lever / event label (e.g. "Field Drive", "Campaign"). */
  lever_event: string;
  /** ISO date string (yyyy-mm-dd) for the event. */
  event_date: string;
  /** Optional event venue / city. */
  event_location: string;
  /**
   * Registration mode key from the network config's `registration_modes`.
   *
   * Set at create time and cannot change. Empty until the config loads.
   */
  registration_mode: string;
  /** Optional, comma-separated free-form tags. Stored on `context.tags`. */
  tags: string;
}

const EMPTY_FORM: CreateLinkFormState = {
  // Empty until the profile loads; an effect then sets the aggregator's domain.
  domain: '',
  state: '',
  district: '',
  lever_event: '',
  event_date: '',
  event_location: '',
  registration_mode: '',
  tags: '',
};

/** Splits a comma-separated tags input into a trimmed, de-duped, non-empty list. */
function parseTags(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(',')) {
    const t = raw.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

function slugifyForLink(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function buildLinkSlug(f: CreateLinkFormState): string | undefined {
  const district = slugifyForLink(f.district);
  const lever = slugifyForLink(f.lever_event);
  if (!district || !lever) return undefined;
  let dateSuffix = '';
  if (f.event_date) {
    const d = new Date(f.event_date);
    if (!Number.isNaN(d.getTime())) {
      const mon = d.toLocaleString('en-US', { month: 'short' }).toLowerCase();
      const yy = String(d.getFullYear()).slice(-2);
      dateSuffix = `-${mon}${yy}`;
    }
  }
  return `${district}-${lever}${dateSuffix}`;
}

function buildLinkTitle(f: CreateLinkFormState): string {
  const parts = [f.district, f.lever_event].filter(Boolean).join(' ');
  if (!f.event_date) return parts || 'Untitled link';
  const d = new Date(f.event_date);
  if (Number.isNaN(d.getTime())) return parts;
  const monYear = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  return parts ? `${parts} — ${monYear}` : monYear;
}

/**
 * Splits a public URL into `{ host, path }` for display.
 *
 * Returns empty parts for a null URL. A malformed URL is returned as the host.
 */
function splitPublicUrl(publicUrl: string | null): { host: string; path: string } {
  if (!publicUrl) return { host: '', path: '' };
  try {
    const u = new URL(publicUrl);
    return { host: u.host, path: u.pathname.replace(/^\//, '') };
  } catch {
    return { host: publicUrl, path: '' };
  }
}

/** How long a success toast stays on screen; long enough to read one short sentence. */
const TOAST_VISIBLE_MS = 2400;

/**
 * Top-right success toast, rendered in a portal on <body>.
 *
 * Closes itself `TOAST_VISIBLE_MS` after it mounts. A parent re-render does
 * not restart the timer; give it a new `key` to show a new message.
 */
function SuccessToast({ message, onDone }: { message: string; onDone: () => void }) {
  const isClient = useIsClient();
  // The latest callback, so a new function from the parent does not restart the timer.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  useEffect(() => {
    const timer = setTimeout(() => onDoneRef.current(), TOAST_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!isClient) return null;
  return createPortal(
    <output
      aria-live="polite"
      className="fixed top-4 left-4 right-4 sm:left-auto z-100 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 shadow-lg inline-flex items-center gap-2"
    >
      <I.check size={14} /> {message}
    </output>,
    document.body,
  );
}

/**
 * QR preview modal with a Download action, rendered in a portal on <body>.
 *
 * The caller generates the PNG data URI in the browser. `dataUrl` is `null`
 * while generating; `error` is set when generation failed.
 */
function QrPreviewModal({
  title,
  dataUrl,
  error,
  onDownload,
  onClose,
}: Readonly<{
  title: string;
  dataUrl: string | null;
  error: string | null;
  onDownload: () => void;
  onClose: () => void;
}>) {
  const t = useTranslations('onboarding');
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Native <dialog> gives focus trapping, focus restore, and Esc-to-close.
  useEffect(() => {
    const el = dialogRef.current;
    el?.showModal?.();
    return () => el?.close?.();
  }, []);

  let body: React.ReactNode;
  if (error) {
    body = <p className="text-[13px] text-rose-600">{error}</p>;
  } else if (dataUrl) {
    body = <img src={dataUrl} alt={title} className="h-52 w-52" />;
  } else {
    body = <p className="text-[13px] text-ink-400">{t('link_card.qr_generating')}</p>;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      onClose={onClose}
      className="m-auto w-full max-w-[340px] rounded-[14px] bg-white p-5 shadow-xl backdrop:bg-black/40"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-[15px] font-bold text-ink-900">{title}</h3>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label={t('link_card.qr_close')}
          className="text-ink-400 hover:text-ink-700"
        >
          <I.x size={16} />
        </button>
      </div>
      <div className="flex min-h-[220px] items-center justify-center rounded-[10px] border border-(--bd-border) bg-ink-50 p-4">
        {body}
      </div>
      <div className="mt-4">
        <button
          type="button"
          onClick={onDownload}
          disabled={!dataUrl}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-primary-600 px-3 py-2 text-[13px] font-semibold text-white hover:bg-primary-700 disabled:opacity-50"
        >
          <I.download size={14} /> {t('link_card.qr_download')}
        </button>
      </div>
    </dialog>
  );
}

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  /** Message under the control, and its element id. */
  error?: { id: string; message: string | undefined };
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block">
        <span className="bd-label">
          {label}
          {required && <span className="text-rose-500 ml-0.5">*</span>}
        </span>
        {children}
      </label>
      {error ? <FieldMessage id={error.id} message={error.message} /> : null}
    </div>
  );
}

/** Required-field checks shared by the create and edit link forms. */
type LinkFieldKey = 'state' | 'lever_event' | 'district' | 'domain' | 'registration_mode';

/** A "{label} is required." error when `value` is empty. */
function requiredError(value: string, message: string): HandFieldError | null {
  return value ? null : { kind: 'required', message };
}

/** Control props plus the Field `error` prop for one key. */
function wire<K extends string>(
  fe: {
    controlProps: (k: K) => HandControlProps;
    errorId: (k: K) => string;
    message: (k: K) => string | undefined;
  },
  key: K,
) {
  return {
    control: fe.controlProps(key),
    error: { id: fe.errorId(key), message: fe.message(key) },
  };
}

export function CreateLinkSection() {
  const t = useTranslations('onboarding');
  const requestErrorText = useRequestErrorText();
  // Root translator for registration mode keys from network config.
  const tRoot = useTranslations();
  const router = useRouter();
  const [form, setForm] = useState<CreateLinkFormState>(EMPTY_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const copy = useFieldErrorCopy();
  const requestMessage = useRequestErrorMessage({
    DUPLICATE_SLUG: t('create_link.error_duplicate_slug'),
  });
  const [toast, setToast] = useState<string | null>(null);
  const create = useCreateLink();
  const profile = useProfile();
  const rawProfile = useProfileRaw();
  const orgName = profile.data?.org ?? '';
  const { domains: servedDomains, active: activeDomain } = useActiveDomain();
  const { data: cfg } = useAggregatorConfig();
  const domainCfg = servedDomains.find((d) => d.id === form.domain);
  // Label for the read-only Domain field, from network config.
  const domainLabel = domainCfg?.plural_label ?? domainCfg?.label ?? form.domain;

  const fe = useHandFieldErrors<LinkFieldKey>('create-link', {
    state: requiredError(form.state, copy.required(t('create_link.field_state'))),
    lever_event: requiredError(form.lever_event, copy.required(t('create_link.field_event'))),
    district: requiredError(form.district, copy.required(t('create_link.field_district'))),
    domain: requiredError(form.domain, copy.required(t('create_link.field_domain'))),
    registration_mode: requiredError(
      form.registration_mode,
      copy.required(t('create_link.field_registration_mode')),
    ),
  });
  const w = (key: LinkFieldKey) => wire(fe, key);

  // Default to the active domain whenever the form holds no served domain,
  // including after the form resets. The API rejects a domain not served.
  useEffect(() => {
    if (!activeDomain) return;
    setForm((f) =>
      servedDomains.some((d) => d.id === f.domain) ? f : { ...f, domain: activeDomain },
    );
  }, [activeDomain, servedDomains, form.domain]);

  // Default the mode once config loads: `form` if declared, else the first
  // mode. Only fills while empty, so a user choice is kept.
  useEffect(() => {
    const modes = cfg?.registration_modes ?? {};
    const keys = Object.keys(modes);
    if (keys.length === 0) return;
    const fallback = keys.includes('form') ? 'form' : keys[0]!;
    setForm((f) => (f.registration_mode ? f : { ...f, registration_mode: fallback }));
  }, [cfg?.registration_modes]);

  // Prefill state, district, and event location from the first postal address
  // on first load. The address is one free-text line; `addressRegion` and
  // `addressLocality` exist only on older rows. State and district are not
  // parsed from free text.
  useEffect(() => {
    const firstLoc = rawProfile.data?.locations?.[0]?.address;
    if (!firstLoc) return;
    setForm((f) => ({
      ...f,
      state: f.state || firstLoc.addressRegion || '',
      district: f.district || firstLoc.addressLocality || '',
      event_location: f.event_location || firstLoc.addressLocality || firstLoc.streetAddress || '',
    }));
  }, [rawProfile.data]);

  const resetSection = () => {
    const firstLoc = rawProfile.data?.locations?.[0]?.address;
    setForm({
      ...EMPTY_FORM,
      state: firstLoc?.addressRegion ?? '',
      district: firstLoc?.addressLocality ?? '',
      event_location: firstLoc?.addressLocality ?? firstLoc?.streetAddress ?? '',
    });
    setCreateError(null);
    fe.reset();
  };

  const onCreate = async () => {
    setCreateError(null);
    if (!fe.validate()) return;
    try {
      const title = buildLinkTitle(form);
      const slug = buildLinkSlug(form);
      const created = await create.mutateAsync({
        domain: form.domain,
        status: 'draft',
        registration_mode: form.registration_mode,
        ...(slug ? { slug } : {}),
        title,
        context: {
          org_name: orgName || undefined,
          title,
          state: form.state || undefined,
          district: form.district || undefined,
          lever_event: form.lever_event || undefined,
          event_date: form.event_date || undefined,
          event_location: form.event_location || undefined,
          ...(parseTags(form.tags).length > 0 ? { tags: parseTags(form.tags) } : {}),
        },
      });
      // Reset the form. `?new=` tells the links list to scroll to and highlight the new draft.
      resetSection();
      setToast(t('create_link.link_created'));
      router.push(`/onboarding?new=${encodeURIComponent(created.link_id)}`);
    } catch (err) {
      setCreateError(requestErrorText(err, requestMessage(err, t('create_link.save_failed'))));
    }
  };

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-6 py-5 flex flex-wrap items-center gap-3 border-b border-(--bd-border)">
        <I.link size={16} className="text-ink-500" />
        <div className="font-display font-bold text-[16px] text-ink-900">
          {t('create_link.title')}
        </div>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11.5px] font-semibold">
          <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block">
            <span className="absolute inset-0 rounded-full bg-emerald-500 opacity-40 animate-pulse-dot" />
          </span>
          {t('create_link.new_badge')}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <Field label={t('create_link.field_org_name')}>
              <input
                className="bd-input bg-ink-50 cursor-not-allowed"
                value={orgName}
                readOnly
                placeholder="—"
              />
            </Field>
          </div>
          <Field label={t('create_link.field_state')} required error={w('state').error}>
            <input
              className="bd-input"
              {...w('state').control}
              value={form.state}
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
              placeholder={t('create_link.placeholder_state')}
            />
          </Field>
          <Field label={t('create_link.field_event')} required error={w('lever_event').error}>
            <input
              className="bd-input"
              {...w('lever_event').control}
              value={form.lever_event}
              onChange={(e) => setForm((f) => ({ ...f, lever_event: e.target.value }))}
              placeholder={t('create_link.placeholder_event')}
            />
          </Field>
          <Field label={t('create_link.field_event_date')}>
            <input
              type="date"
              className="bd-input"
              value={form.event_date}
              onChange={(e) => setForm((f) => ({ ...f, event_date: e.target.value }))}
            />
          </Field>
          <Field label={t('create_link.field_event_location')}>
            <input
              className="bd-input"
              value={form.event_location}
              onChange={(e) => setForm((f) => ({ ...f, event_location: e.target.value }))}
              placeholder={t('create_link.placeholder_location')}
            />
          </Field>
          <Field label={t('create_link.field_district')} required error={w('district').error}>
            <input
              className="bd-input"
              {...w('district').control}
              value={form.district}
              onChange={(e) => setForm((f) => ({ ...f, district: e.target.value }))}
              placeholder={t('create_link.placeholder_district')}
            />
          </Field>
          <Field label={t('create_link.field_domain')} required error={w('domain').error}>
            {servedDomains.length > 1 ? (
              <DomainSelect
                domains={servedDomains}
                value={form.domain}
                onChange={(id) => setForm((f) => ({ ...f, domain: id }))}
                className="w-full px-3 py-2.5 text-[14px]"
              />
            ) : (
              // Read-only: the coordinator serves one domain.
              <input
                className="bd-input"
                {...w('domain').control}
                value={domainLabel}
                readOnly
                aria-readonly="true"
              />
            )}
          </Field>
          {/*
           * Registration mode, set at create time and fixed afterwards. Options
           * come from the network config's `registration_modes`. The mode's
           * `public_hint_i18n_key` is for the public form, so it is not shown here.
           */}
          <Field
            label={t('create_link.field_registration_mode')}
            required
            error={w('registration_mode').error}
          >
            <SelectField
              {...w('registration_mode').control}
              value={form.registration_mode}
              onChange={(v) => setForm((f) => ({ ...f, registration_mode: v }))}
              options={Object.entries(cfg?.registration_modes ?? {}).map(([key, mode]) => ({
                value: key,
                label: tRoot(mode.label_i18n_key),
              }))}
            />
          </Field>
          {/* Optional free-form tags (comma-separated). Stored on context.tags. */}
          <Field label={t('create_link.field_tags')}>
            <input
              className="bd-input"
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              placeholder={t('create_link.placeholder_tags')}
            />
          </Field>
          <div className="md:col-span-2 flex items-center justify-end gap-2 mt-2 flex-wrap">
            <Button onClick={onCreate} disabled={create.isPending}>
              {create.isPending ? t('create_link.creating') : t('create_link.create_button')}
            </Button>
          </div>
          {createError && (
            <div
              role="alert"
              className="md:col-span-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2"
            >
              {createError}
            </div>
          )}
        </div>

        <div className="border-t lg:border-t-0 lg:border-l border-(--bd-border) bg-linear-to-b from-(--bd-tint-primary) to-(--bd-card) p-6 flex flex-col items-center text-center">
          <div className="flex items-center gap-2 self-start text-[12.5px] font-semibold text-ink-500">
            <I.qr size={14} /> {t('create_link.qr_label')}
          </div>
          <div className="mt-4 p-3 bg-white rounded-[14px] border border-(--bd-border) bd-shadow-lg">
            <div className="w-[200px] h-[200px] flex items-center justify-center text-ink-300 text-[12px] text-center px-4">
              {t('create_link.qr_placeholder')}
            </div>
          </div>
        </div>
      </div>
      {toast && <SuccessToast key={toast} message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/**
 * Scrolls a just-created card into view and shows a ring for about 2s.
 *
 * @returns The card ref and whether the ring is shown.
 */
function useHighlightOnMount(highlight: boolean) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [ringed, setRinged] = useState(highlight);
  useEffect(() => {
    if (!highlight) return;
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => setRinged(false), 2000);
    return () => clearTimeout(timer);
  }, [highlight]);
  return { cardRef, ringed };
}

/** Pill and dot colours per link status. */
const STATUS_STYLE: Record<string, { pill: string; dot: string }> = {
  live: { pill: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  retired: { pill: 'bg-rose-50 text-rose-700', dot: 'bg-rose-500' },
};
const DRAFT_STATUS_STYLE = { pill: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' };

function LinkCard({
  link,
  highlight = false,
}: Readonly<{
  link: ApiRegistrationLink;
  /** True for a just-created link (`?new=`); scrolls to and highlights it. */
  highlight?: boolean;
}>) {
  const t = useTranslations('onboarding');
  const requestErrorText = useRequestErrorText();
  const format = useFormatter();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const { cardRef, ringed } = useHighlightOnMount(highlight);
  const activate = useActivateLink();
  const deactivate = useDeactivateLink();
  const update = useUpdateLink();
  const copy = useFieldErrorCopy();
  const requestMessage = useRequestErrorMessage({
    DUPLICATE_SLUG: t('create_link.error_duplicate_slug'),
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const isLive = link.status === 'live';
  const isDraft = link.status === 'draft';
  const badge = STATUS_STYLE[link.status] ?? DRAFT_STATUS_STYLE;
  const ctx = (link.context ?? {}) as Record<string, unknown>;
  const ctxString = (key: string): string =>
    typeof ctx[key] === 'string' ? (ctx[key] as string) : '';
  const title =
    (typeof ctx['title'] === 'string' && ctx['title']) ||
    [ctx['district'], ctx['lever_event']].filter(Boolean).join(' ') ||
    link.slug;
  const subtitle =
    [ctx['org_name'], ctx['event_location']].filter(Boolean).join(' · ') ||
    `${t('link_card.created_prefix')} ${format.dateTime(new Date(link.created_at), { day: '2-digit', month: 'short', year: 'numeric' })}`;

  // `<host>/<orgSlug>/<slug>`. Empty when `public_url` is null.
  const { host: urlHost, path: urlPath } = splitPublicUrl(link.public_url);
  const onCopy = async () => {
    if (!link.public_url || !navigator.clipboard) return;
    await navigator.clipboard.writeText(link.public_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  // The QR is generated in the browser from the public URL when the preview opens.
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const openQr = async () => {
    if (!link.public_url) return;
    setQrError(null);
    setQrOpen(true);
    try {
      const dataUrl = await QRCode.toDataURL(link.public_url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 512,
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      console.error('qr generation failed', err);
      setQrError(t('link_card.qr_error'));
    }
  };
  const downloadQr = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `qr-${link.slug}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Inline edit form state (drafts only). The server regenerates the slug on save.
  const [editForm, setEditForm] = useState<CreateLinkFormState>(() => ({
    domain: link.domain,
    state: ctxString('state'),
    district: ctxString('district'),
    lever_event: ctxString('lever_event'),
    event_date: ctxString('event_date'),
    event_location: ctxString('event_location'),
    // Shown read-only. The edit request must not send a new registration_mode.
    registration_mode: link.registration_mode ?? 'form',
    tags: Array.isArray(ctx['tags']) ? (ctx['tags'] as string[]).join(', ') : '',
  }));
  const [editError, setEditError] = useState<string | null>(null);
  const editFe = useHandFieldErrors<LinkFieldKey>(`edit-link-${link.link_id}`, {
    state: requiredError(editForm.state, copy.required(t('create_link.field_state'))),
    district: requiredError(editForm.district, copy.required(t('create_link.field_district'))),
    lever_event: requiredError(editForm.lever_event, copy.required(t('create_link.field_event'))),
  });
  const ew = (key: LinkFieldKey) => wire(editFe, key);
  const onSaveEdit = async () => {
    setEditError(null);
    if (!editFe.validate()) return;
    try {
      const slug = buildLinkSlug(editForm);
      const editTitle = buildLinkTitle(editForm);
      await update.mutateAsync({
        id: link.link_id,
        patch: {
          ...(slug ? { slug } : {}),
          context: {
            ...ctx,
            title: editTitle,
            state: editForm.state || undefined,
            district: editForm.district || undefined,
            lever_event: editForm.lever_event || undefined,
            event_date: editForm.event_date || undefined,
            event_location: editForm.event_location || undefined,
            tags: parseTags(editForm.tags),
          },
        },
      });
      setEditing(false);
    } catch (err) {
      setEditError(requestErrorText(err, requestMessage(err, t('create_link.save_failed'))));
    }
  };

  return (
    <div
      ref={cardRef}
      className={`bd-card p-5 hover:border-(--bd-primary-100) transition-all ${
        ringed ? 'ring-2 ring-primary-400 ring-offset-2' : ''
      }`}
    >
      {/* Actions stack under the card body below `sm`. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-[16px] text-ink-900 leading-tight">
              {title}
            </h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${badge.pill}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${badge.dot}`} />
              {isLive ? t('link_card.active') : link.status}
            </span>
          </div>

          <p className="text-[12.5px] text-ink-400 mt-1.5">{subtitle}</p>

          {/* Public URL and QR only for live links; drafts have a null public_url. */}
          {isLive && link.public_url && (
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <div className="inline-flex flex-wrap sm:flex-nowrap items-center gap-1 min-w-0 max-w-full bg-ink-50 border border-(--bd-border) rounded-[10px] px-3 py-1.5 text-[12.5px] font-mono">
                <span className="text-ink-500">{urlHost}/</span>
                {/* Below `sm` a long slug wraps inside the pill. */}
                <span className="min-w-0 wrap-anywhere text-amber-700 font-semibold">
                  {urlPath}
                </span>
                {/* Copy button for the public URL; shows the copied confirmation. */}
                <button
                  type="button"
                  onClick={onCopy}
                  title={copied ? t('link_card.copied') : t('link_card.copy_title')}
                  aria-label={t('link_card.copy_title')}
                  className={`ml-1 shrink-0 ${copied ? 'text-emerald-600' : 'text-ink-400 hover:text-primary-600'}`}
                >
                  {copied ? <I.check size={12} /> : <I.copy size={12} />}
                </button>
              </div>
              <button
                type="button"
                onClick={openQr}
                title={t('link_card.view_qr')}
                className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-(--bd-border) text-ink-500 hover:text-primary-600 hover:border-(--bd-primary-100)"
              >
                <I.qr size={14} />
              </button>
              <a
                href={link.public_url}
                target="_blank"
                rel="noopener noreferrer"
                title={t('link_card.open_link')}
                className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-(--bd-border) text-ink-500 hover:text-primary-600 hover:border-(--bd-primary-100)"
              >
                <I.link size={14} />
              </a>
            </div>
          )}
          {qrOpen && (
            <QrPreviewModal
              title={t('link_card.qr_modal_title')}
              dataUrl={qrDataUrl}
              error={qrError}
              onDownload={downloadQr}
              onClose={() => setQrOpen(false)}
            />
          )}

          {isDraft && !editing && (
            <div className="mt-3 text-[12.5px] text-ink-400">{t('link_card.draft_notice')}</div>
          )}

          {/* Metadata row */}
          <div className="flex items-center gap-4 mt-3.5 text-[12.5px] flex-wrap">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-[11.5px] ${
                link.domain === 'seeker' ? 'bg-amber-50 text-amber-700' : 'bg-sky-50 text-sky-700'
              }`}
            >
              {link.domain}
            </span>
            <span className="text-ink-700">
              <strong className="font-bold">{link.metrics?.total ?? 0}</strong>{' '}
              <span className="text-ink-400">{t('link_card.registrations')}</span>
            </span>
            <span className="text-ink-700">
              <strong className="font-bold">{link.metrics?.passed ?? 0}</strong>{' '}
              <span className="text-ink-400">{t('link_card.verified')}</span>
            </span>
            <span className="text-ink-400">
              {t('link_card.created_prefix')}{' '}
              {format.dateTime(new Date(link.created_at), {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </span>
            {link.expires_at && (
              <span className="text-ink-400">
                {t('link_card.expires_prefix')}{' '}
                {format.dateTime(new Date(link.expires_at), {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {isDraft && !editing && (
            <Button kind="ghost" onClick={() => setEditing(true)} disabled={update.isPending}>
              {t('link_card.edit')}
            </Button>
          )}
          {isDraft && (
            <Button
              onClick={() => {
                setActionError(null);
                activate.mutate(link.link_id, {
                  onError: (err) => setActionError(requestMessage(err)),
                });
              }}
              disabled={activate.isPending || editing || update.isPending}
            >
              {activate.isPending ? t('link_card.going_live') : t('link_card.make_live')}
            </Button>
          )}
          {isLive && (
            <Button
              kind="ghost"
              onClick={() => {
                setActionError(null);
                deactivate.mutate(link.link_id, {
                  onError: (err) => setActionError(requestMessage(err)),
                });
              }}
              disabled={deactivate.isPending}
            >
              {deactivate.isPending ? t('link_card.retiring') : t('link_card.deactivate')}
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          className="mt-3 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2"
        >
          {actionError}
        </div>
      )}

      {isDraft && editing && (
        <div className="mt-4 pt-4 border-t border-(--bd-border) grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label={t('create_link.field_state')} required error={ew('state').error}>
            <input
              className="bd-input"
              {...ew('state').control}
              value={editForm.state}
              onChange={(e) => setEditForm((f) => ({ ...f, state: e.target.value }))}
            />
          </Field>
          <Field label={t('create_link.field_district')} required error={ew('district').error}>
            <input
              className="bd-input"
              {...ew('district').control}
              value={editForm.district}
              onChange={(e) => setEditForm((f) => ({ ...f, district: e.target.value }))}
            />
          </Field>
          <Field label={t('create_link.field_event')} required error={ew('lever_event').error}>
            <input
              className="bd-input"
              {...ew('lever_event').control}
              value={editForm.lever_event}
              onChange={(e) => setEditForm((f) => ({ ...f, lever_event: e.target.value }))}
            />
          </Field>
          <Field label={t('create_link.field_event_date')}>
            <input
              type="date"
              className="bd-input"
              value={editForm.event_date}
              onChange={(e) => setEditForm((f) => ({ ...f, event_date: e.target.value }))}
            />
          </Field>
          <Field label={t('create_link.field_event_location')}>
            <input
              className="bd-input"
              value={editForm.event_location}
              onChange={(e) => setEditForm((f) => ({ ...f, event_location: e.target.value }))}
            />
          </Field>
          {editError && (
            <div
              role="alert"
              className="md:col-span-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2"
            >
              {editError}
            </div>
          )}
          <div className="md:col-span-2 flex items-center justify-end gap-2">
            <Button kind="ghost" onClick={() => setEditing(false)} disabled={update.isPending}>
              {t('link_card.cancel')}
            </Button>
            <Button onClick={onSaveEdit} disabled={update.isPending}>
              {update.isPending ? t('link_card.saving') : t('link_card.save_draft')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Your Registration Links" list body, without an outer card.
 *
 * Render it inside a parent card.
 */
export function YourLinksBody() {
  const t = useTranslations('onboarding');
  const requestErrorText = useRequestErrorText();
  // `?new=<link_id>` is set by the create flow to highlight the new draft.
  const newLinkId = useSearchParams().get('new');
  // Show the create confirmation here, after navigation from the create page.
  const [dismissedLinkId, setDismissedLinkId] = useState<string | null>(null);
  const toast = newLinkId && newLinkId !== dismissedLinkId ? t('your_links.draft_created') : null;
  const { domains: servedDomains, active, setActive } = useActiveDomain();
  const aggregatorType: string = active ?? '';
  // Links are filtered to the active domain.
  const { data, isLoading, error } = useRegistrationLinks(aggregatorType);
  const requestMessage = useRequestErrorMessage();
  const links: ApiRegistrationLink[] = data ?? [];
  const activeCount = links.filter((l) => l.status === 'live').length;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-display font-bold text-[14px] text-ink-700">
            {t('your_links.title')}
          </div>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold">
            {t('your_links.active_count', { count: activeCount })}
          </span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-ink-50 text-ink-600 text-[11px] font-semibold capitalize">
            {t('your_links.type_pill', { type: aggregatorType })}
          </span>
        </div>
        <DomainSelect domains={servedDomains} value={active} onChange={setActive} />
      </div>
      <div className="flex flex-col gap-3 overflow-y-auto pr-1" style={{ maxHeight: 300 }}>
        {isLoading ? (
          <div className="text-center py-8 text-ink-400 text-[13px]">{t('your_links.loading')}</div>
        ) : error ? (
          <div className="text-center py-8 text-rose-600 text-[13px]">
            {requestErrorText(error, requestMessage(error, t('your_links.load_failed')))}
          </div>
        ) : links.length === 0 ? (
          <div className="text-center py-8 text-ink-400 text-[13px]">
            {t('your_links.empty', { type: aggregatorType })}
          </div>
        ) : (
          links.map((l) => (
            <LinkCard key={l.link_id} link={l} highlight={l.link_id === newLinkId} />
          ))
        )}
      </div>
      {toast && (
        <SuccessToast
          key={newLinkId}
          message={toast}
          onDone={() => setDismissedLinkId(newLinkId)}
        />
      )}
    </div>
  );
}
