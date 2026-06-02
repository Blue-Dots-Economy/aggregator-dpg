'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useTranslations, useFormatter } from 'next-intl';
import { Button } from '../../../../components/ui/Button';
import { I } from '../../../../icons';
import {
  useActivateLink,
  useCreateLink,
  useDeactivateLink,
  useRegistrationLinks,
  useUpdateLink,
} from '../../../../hooks/useOnboarding';
import { useProfile, useProfileRaw } from '../../../../hooks/useProfile';
import type { ApiRegistrationLink } from '../../../../services/onboarding.service';

interface CreateLinkFormState {
  domain: 'seeker' | 'provider';
  /** Instance (state of operation). Drives slug + display title. */
  state: string;
  /** District — required, drives slug + display title. */
  district: string;
  /** Free-form lever / event label (e.g. "Field Drive", "Campaign"). */
  lever_event: string;
  /** ISO date string (yyyy-mm-dd) for the event. */
  event_date: string;
  /** Optional event venue / city. */
  event_location: string;
}

const EMPTY_FORM: CreateLinkFormState = {
  domain: 'seeker',
  state: '',
  district: '',
  lever_event: '',
  event_date: '',
  event_location: '',
};

function slugifyForLink(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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
 * Top-right green toast for success notifications. Portals to <body> so a
 * transformed ancestor (e.g. `fade-up`) can't pin it inside the section. Auto-
 * dismisses after 2400ms, matching the profile-save toast.
 */
function SuccessToast({ message, onDone }: { message: string; onDone: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [onDone]);
  if (!mounted) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 right-4 z-[100] rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 shadow-lg inline-flex items-center gap-2"
    >
      <I.check size={14} /> {message}
    </div>,
    document.body,
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="bd-label">
        {label}
        {required && <span className="text-rose-500 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}

export function CreateLinkSection() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const [form, setForm] = useState<CreateLinkFormState>(EMPTY_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const create = useCreateLink();
  const profile = useProfile();
  const rawProfile = useProfileRaw();
  const orgName = profile.data?.org ?? '';
  const aggregatorType: 'seeker' | 'provider' = rawProfile.data?.type ?? 'seeker';

  // Pin the link domain to the aggregator's registered type — the API
  // rejects mismatches with AGGREGATOR_TYPE_MISMATCH, so the UI never lets
  // the user pick the wrong one.
  useEffect(() => {
    if (rawProfile.data?.type) {
      setForm((f) =>
        f.domain === rawProfile.data.type ? f : { ...f, domain: rawProfile.data.type! },
      );
    }
  }, [rawProfile.data?.type]);

  // Prefill state / district / event location from the aggregator's first
  // postal address. User can still override. Only fills on first load —
  // subsequent edits stay sticky.
  useEffect(() => {
    const firstLoc = rawProfile.data?.locations?.[0]?.address;
    if (!firstLoc) return;
    setForm((f) => ({
      ...f,
      state: f.state || firstLoc.addressRegion || '',
      district: f.district || firstLoc.addressLocality || '',
      event_location: f.event_location || firstLoc.addressLocality || '',
    }));
  }, [rawProfile.data]);

  const resetSection = () => {
    const firstLoc = rawProfile.data?.locations?.[0]?.address;
    setForm({
      ...EMPTY_FORM,
      state: firstLoc?.addressRegion ?? '',
      district: firstLoc?.addressLocality ?? '',
      event_location: firstLoc?.addressLocality ?? '',
    });
    setCreateError(null);
  };

  const onCreate = async () => {
    setCreateError(null);
    if (!form.state || !form.district || !form.lever_event) {
      setCreateError(t('create_link.error_required'));
      return;
    }
    try {
      const title = buildLinkTitle(form);
      const slug = buildLinkSlug(form);
      await create.mutateAsync({
        domain: form.domain,
        status: 'draft',
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
        },
      });
      // Refresh the form so the user can compose the next link from scratch.
      // The newly-created draft appears in "Your Registration Links" below;
      // edits + Make Live happen on its card, not here.
      resetSection();
      setToast(t('create_link.link_created'));
      router.push('/onboarding');
    } catch (err) {
      setCreateError((err as Error).message);
    }
  };

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-6 py-5 flex items-center gap-3 border-b border-[var(--bd-border)]">
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
          <Field label={t('create_link.field_state')} required>
            <input
              className="bd-input"
              value={form.state}
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
              placeholder={t('create_link.placeholder_state')}
            />
          </Field>
          <Field label={t('create_link.field_event')} required>
            <input
              className="bd-input"
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
          <Field label={t('create_link.field_district')} required>
            <input
              className="bd-input"
              value={form.district}
              onChange={(e) => setForm((f) => ({ ...f, district: e.target.value }))}
              placeholder={t('create_link.placeholder_district')}
            />
          </Field>
          <Field label={t('create_link.field_domain')} required>
            {/*
             * Pinned to the aggregator's registered type — single-type
             * enforcement is what the API expects. Rendered read-only so
             * the user sees the value but can't switch domains.
             */}
            <input
              className="bd-input"
              value={aggregatorType === 'seeker' ? 'Seeker' : 'Provider'}
              readOnly
              aria-readonly="true"
            />
          </Field>
          <div className="md:col-span-2 flex items-center justify-end gap-2 mt-2 flex-wrap">
            <Button onClick={onCreate} disabled={create.isPending}>
              {create.isPending ? t('create_link.creating') : t('create_link.create_button')}
            </Button>
          </div>
          {createError && (
            <div className="md:col-span-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2">
              {createError}
            </div>
          )}
        </div>

        <div className="border-t lg:border-t-0 lg:border-l border-[var(--bd-border)] bg-gradient-to-b from-[var(--bd-tint-primary)] to-[var(--bd-card)] p-6 flex flex-col items-center text-center">
          <div className="flex items-center gap-2 self-start text-[12.5px] font-semibold text-ink-500">
            <I.qr size={14} /> {t('create_link.qr_label')}
          </div>
          <div className="mt-4 p-3 bg-white rounded-[14px] border border-[var(--bd-border)] bd-shadow-lg">
            <div className="w-[200px] h-[200px] flex items-center justify-center text-ink-300 text-[12px] text-center px-4">
              {t('create_link.qr_placeholder')}
            </div>
          </div>
        </div>
      </div>
      {toast && <SuccessToast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function LinkCard({ link }: { link: ApiRegistrationLink }) {
  const t = useTranslations('onboarding');
  const format = useFormatter();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const activate = useActivateLink();
  const deactivate = useDeactivateLink();
  const update = useUpdateLink();
  const isLive = link.status === 'live';
  const isDraft = link.status === 'draft';
  const ctx = (link.context ?? {}) as Record<string, unknown>;
  const ctxString = (key: string): string =>
    typeof ctx[key] === 'string' ? (ctx[key] as string) : '';
  const title =
    (typeof ctx['title'] === 'string' && ctx['title']) ||
    [ctx['district'], ctx['lever_event']].filter(Boolean).join(' ') ||
    link.slug;
  const subtitle =
    [ctx['org_name'], ctx['event_location']].filter(Boolean).join(' · ') ||
    `Created ${format.dateTime(new Date(link.created_at), { day: '2-digit', month: 'short', year: 'numeric' })}`;

  // Render `<host>/<orgSlug>/<slug>` with the slug emphasised. Only computed
  // when the row is published (live) — drafts and retired rows carry a null
  // public_url.
  let urlHost = '';
  let urlPath = '';
  if (link.public_url) {
    urlHost = link.public_url;
    try {
      const u = new URL(link.public_url);
      urlHost = u.host;
      urlPath = u.pathname.replace(/^\//, '');
    } catch {
      /* keep raw */
    }
  }
  const onCopy = async () => {
    if (!link.public_url || !navigator.clipboard) return;
    await navigator.clipboard.writeText(link.public_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Inline edit form state — drafts only. Pre-populated from the link's
  // current context. Slug is regenerated server-side from district+lever+date
  // on save (matches the create flow).
  const [editForm, setEditForm] = useState<CreateLinkFormState>(() => ({
    domain: link.domain,
    state: ctxString('state'),
    district: ctxString('district'),
    lever_event: ctxString('lever_event'),
    event_date: ctxString('event_date'),
    event_location: ctxString('event_location'),
  }));
  const [editError, setEditError] = useState<string | null>(null);
  const onSaveEdit = async () => {
    setEditError(null);
    if (!editForm.state || !editForm.district || !editForm.lever_event) {
      setEditError(t('link_card.error_required'));
      return;
    }
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
          },
        },
      });
      setEditing(false);
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  return (
    <div className="bd-card p-5 hover:border-[var(--bd-primary-100)] transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-[16px] text-ink-900 leading-tight">
              {title}
            </h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                isLive
                  ? 'bg-emerald-50 text-emerald-700'
                  : link.status === 'retired'
                    ? 'bg-rose-50 text-rose-700'
                    : 'bg-amber-50 text-amber-700'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full inline-block ${
                  isLive
                    ? 'bg-emerald-500'
                    : link.status === 'retired'
                      ? 'bg-rose-500'
                      : 'bg-amber-500'
                }`}
              />
              {isLive ? t('link_card.active') : link.status}
            </span>
          </div>

          <p className="text-[12.5px] text-ink-400 mt-1.5">{subtitle}</p>

          {/*
           * Public URL + QR are only meaningful once the link is live. Drafts
           * carry a null public_url from the API; rendering it here would
           * show "host/null" and copy the literal string — both wrong.
           */}
          {isLive && link.public_url && (
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <div className="inline-flex items-center gap-1 bg-ink-50 border border-[var(--bd-border)] rounded-[10px] px-3 py-1.5 text-[12.5px] font-mono">
                <span className="text-ink-500">{urlHost}/</span>
                <span className="text-amber-700 font-semibold">{urlPath}</span>
                <button
                  type="button"
                  onClick={onCopy}
                  title={t('link_card.copy_title')}
                  className="ml-1 text-ink-400 hover:text-primary-600"
                >
                  <I.copy size={12} />
                </button>
              </div>
              {link.qr_url && (
                <a
                  href={link.qr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('link_card.view_qr')}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-[var(--bd-border)] text-ink-500 hover:text-primary-600 hover:border-[var(--bd-primary-100)]"
                >
                  <I.qr size={14} />
                </a>
              )}
              <a
                href={link.public_url}
                target="_blank"
                rel="noopener noreferrer"
                title={t('link_card.open_link')}
                className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-[var(--bd-border)] text-ink-500 hover:text-primary-600 hover:border-[var(--bd-primary-100)]"
              >
                <I.link size={14} />
              </a>
              <button
                type="button"
                onClick={onCopy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[var(--bd-border)] text-ink-600 text-[12.5px] font-semibold hover:bg-ink-50"
              >
                {copied ? t('link_card.copied') : t('link_card.copy_link')}
              </button>
            </div>
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

        <div className="flex items-center gap-2 shrink-0">
          {isDraft && !editing && (
            <Button kind="ghost" onClick={() => setEditing(true)} disabled={update.isPending}>
              {t('link_card.edit')}
            </Button>
          )}
          {isDraft && (
            <Button
              onClick={() => activate.mutate(link.link_id)}
              disabled={activate.isPending || editing || update.isPending}
            >
              {activate.isPending ? t('link_card.going_live') : t('link_card.make_live')}
            </Button>
          )}
          {isLive && (
            <Button
              kind="ghost"
              onClick={() => deactivate.mutate(link.link_id)}
              disabled={deactivate.isPending}
            >
              {deactivate.isPending ? t('link_card.retiring') : t('link_card.deactivate')}
            </Button>
          )}
        </div>
      </div>

      {isDraft && editing && (
        <div className="mt-4 pt-4 border-t border-[var(--bd-border)] grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label={t('create_link.field_state')} required>
            <input
              className="bd-input"
              value={editForm.state}
              onChange={(e) => setEditForm((f) => ({ ...f, state: e.target.value }))}
            />
          </Field>
          <Field label={t('create_link.field_district')} required>
            <input
              className="bd-input"
              value={editForm.district}
              onChange={(e) => setEditForm((f) => ({ ...f, district: e.target.value }))}
            />
          </Field>
          <Field label={t('create_link.field_event')} required>
            <input
              className="bd-input"
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
            <div className="md:col-span-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2">
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
 * Body-only "Your Registration Links" list. Designed to be rendered INSIDE
 * another card shell (the merged Registration via Link section on the
 * onboarding landing). No outer card padding/border — parent owns chrome.
 */
export function YourLinksBody() {
  const t = useTranslations('onboarding');
  const rawProfile = useProfileRaw();
  const aggregatorType: 'seeker' | 'provider' = rawProfile.data?.type ?? 'seeker';
  // The aggregator only ever has links of its registered type — no tab
  // switcher needed. Filter is pinned via `aggregatorType`.
  const { data, isLoading, error } = useRegistrationLinks(aggregatorType);
  const links: ApiRegistrationLink[] = data ?? [];
  const activeCount = links.filter((l) => l.status === 'live').length;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="font-display font-bold text-[14px] text-ink-700">
            {t('your_links.title')}
          </div>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold">
            {t('your_links.active_count', { count: activeCount })}
          </span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-ink-50 text-ink-600 text-[11px] font-semibold capitalize">
            {aggregatorType} links
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-3 overflow-y-auto pr-1" style={{ maxHeight: 300 }}>
        {isLoading ? (
          <div className="text-center py-8 text-ink-400 text-[13px]">{t('your_links.loading')}</div>
        ) : error ? (
          <div className="text-center py-8 text-rose-600 text-[13px]">
            {(error as Error).message}
          </div>
        ) : links.length === 0 ? (
          <div className="text-center py-8 text-ink-400 text-[13px]">
            {t('your_links.empty', { type: aggregatorType })}
          </div>
        ) : (
          links.map((l) => <LinkCard key={l.link_id} link={l} />)
        )}
      </div>
    </div>
  );
}
