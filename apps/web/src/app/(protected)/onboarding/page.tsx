'use client';

import { useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Topbar } from '../../../components/shell/Topbar';
import { Dropzone } from '../../../components/ui/Dropzone';
import { I } from '../../../icons';
import {
  useBulkUpload,
  useCreateLink,
  useDeactivateLink,
  useOnboardingSummary,
  useRecentBulkUploads,
  useRegistrationLinks,
} from '../../../hooks/useOnboarding';
import type { ApiRegistrationLink, BulkUploadStatus } from '../../../services/onboarding.service';
import { onboardingService } from '../../../services/onboarding.service';
import { useProfile } from '../../../hooks/useProfile';

interface StatItem {
  icon: 'users' | 'shield' | 'alert' | 'refresh';
  label: string;
  count: number;
  tone: string;
  bg: string;
}

function StatStrip() {
  const summary = useOnboardingSummary();
  const items: StatItem[] = useMemo(() => {
    const total = summary.data?.total ?? 0;
    const passed = summary.data?.passed ?? 0;
    const failed = summary.data?.failed ?? 0;
    const skipped = summary.data?.skipped ?? 0;
    return [
      {
        icon: 'users',
        label: 'Total registered',
        count: total,
        tone: '#6366F1',
        bg: '#EEF2FF',
      },
      {
        icon: 'shield',
        label: 'Verified & onboarded',
        count: passed,
        tone: '#10B981',
        bg: '#ECFDF5',
      },
      {
        icon: 'alert',
        label: 'Failed validations',
        count: failed,
        tone: '#EF4444',
        bg: '#FEF2F2',
      },
      {
        icon: 'refresh',
        label: 'Skipped (already registered)',
        count: skipped,
        tone: '#B45309',
        bg: '#FEF3C7',
      },
    ];
  }, [summary.data]);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {items.map((it, i) => {
        const Ic = I[it.icon];
        return (
          <div key={i} className="bd-card bd-shadow p-5 flex items-center gap-4">
            <div
              className="w-11 h-11 rounded-[12px] flex items-center justify-center"
              style={{ background: it.bg, color: it.tone }}
            >
              <Ic size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="font-display font-bold text-[28px] leading-none tracking-tight"
                style={{ color: it.tone }}
              >
                {summary.isLoading ? '…' : it.count}
              </div>
              <div className="text-[13px] text-ink-500 mt-1.5">{it.label}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CSVUpload() {
  const [participantType, setParticipantType] = useState<'seeker' | 'provider'>('seeker');
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useBulkUpload();
  const recent = useRecentBulkUploads(10);
  // Summary lives in a sibling component (StatStrip) but the manual-refresh
  // affordance should refetch both — the top counters lag behind otherwise.
  const summary = useOnboardingSummary();

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setPickedFile(f);
      setUploadError(null);
      setUploadNotice(null);
    }
  };

  const onUpload = async () => {
    if (!pickedFile) return;
    setUploadError(null);
    setUploadNotice(null);
    try {
      const result = await upload.mutateAsync({ file: pickedFile, participantType });
      setPickedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (result.duplicate) {
        setUploadNotice(
          result.message ?? 'This CSV was already uploaded earlier — showing the existing run.',
        );
      }
      recent.refetch();
    } catch (err) {
      setUploadError((err as Error).message);
    }
  };

  const downloadTemplate = () => {
    window.location.href = `/api/bulk-uploads/template?participant_type=${participantType}`;
  };

  return (
    <div className="bd-card bd-shadow p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <div className="font-display font-bold text-[16px] text-ink-900">Add participants</div>
          <div className="text-[12.5px] text-ink-400 mt-0.5">
            Bulk upload via CSV — fastest way to import existing rosters.
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center bg-ink-50 border border-[var(--bd-border)] rounded-[10px] p-0.5">
            <button
              type="button"
              onClick={() => setParticipantType('seeker')}
              className={`px-3 py-1.5 rounded-[8px] text-[12.5px] font-semibold transition-all ${
                participantType === 'seeker'
                  ? 'bg-white text-amber-700 bd-shadow'
                  : 'text-ink-500 hover:text-ink-700'
              }`}
            >
              Seekers
            </button>
            <button
              type="button"
              onClick={() => setParticipantType('provider')}
              className={`px-3 py-1.5 rounded-[8px] text-[12.5px] font-semibold transition-all ${
                participantType === 'provider'
                  ? 'bg-white text-primary-600 bd-shadow'
                  : 'text-ink-500 hover:text-ink-700'
              }`}
            >
              Providers
            </button>
          </div>
          <button
            type="button"
            onClick={downloadTemplate}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary-600 hover:underline"
          >
            <I.download size={14} /> Download template
          </button>
        </div>
      </div>

      <Dropzone>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={onPick}
          className="hidden"
          id="csv-file-input"
        />
        {pickedFile ? (
          // Selected-file chip with explicit × dismissal. Cleared state +
          // resets the file input so the same filename can be re-picked.
          <div className="flex items-center justify-center gap-2">
            <div className="inline-flex items-center gap-2 max-w-full px-3 py-2 rounded-[10px] bg-[var(--bd-primary-50)] border border-[var(--bd-primary-100)]">
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
                  setUploadError(null);
                  setUploadNotice(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                title="Remove file"
                aria-label="Remove file"
                className="inline-flex items-center justify-center w-6 h-6 rounded-full text-ink-500 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0"
              >
                <I.x size={13} />
              </button>
            </div>
          </div>
        ) : (
          <label htmlFor="csv-file-input" className="cursor-pointer block text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-white border border-[var(--bd-border)] flex items-center justify-center text-primary-600 mb-3 bd-shadow">
              <I.upload size={20} />
            </div>
            <div className="text-[14px] font-semibold text-ink-700">
              Drag your CSV here or{' '}
              <span className="text-primary-600 underline-offset-2">click to browse</span>
            </div>
            <div className="text-[12px] text-ink-400 mt-1">
              .csv only · UTF-8 encoded · uploaded as {participantType}s
            </div>
          </label>
        )}
      </Dropzone>

      <div className="flex items-center justify-between mt-4">
        <div className="text-[12px] text-ink-400 flex items-center gap-2">
          <I.shield size={14} className="text-emerald-500" /> All uploads are scanned and validated
          before import.
        </div>
        <Button onClick={onUpload} disabled={!pickedFile || upload.isPending}>
          {upload.isPending ? 'Uploading…' : 'Upload'}
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

      <RecentUploadsTable
        items={recent.data?.items ?? []}
        loading={recent.isLoading}
        fetching={recent.isFetching || summary.isFetching}
        error={recent.error as Error | null}
        onRefresh={() => {
          void recent.refetch();
          void summary.refetch();
        }}
      />
    </div>
  );
}

function RecentUploadsTable({
  items,
  loading,
  error,
  fetching,
  onRefresh,
}: {
  items: BulkUploadStatus[];
  loading: boolean;
  fetching: boolean;
  error: Error | null;
  onRefresh: () => void;
}) {
  return (
    <div className="mt-5 border-t border-[var(--bd-border)] pt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-display font-bold text-[14px] text-ink-700">Recent uploads</div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={fetching}
          title="Refresh for latest status"
          aria-label="Refresh"
          className="inline-flex items-center justify-center w-7 h-7 rounded-full text-ink-500 hover:text-primary-600 hover:bg-[var(--bd-primary-50)] disabled:opacity-40 transition-colors"
        >
          <I.refresh size={14} className={fetching ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="overflow-x-auto scroll-x">
        <table className="bd-table" style={{ minWidth: 800 }}>
          <thead>
            <tr>
              <th>Uploaded</th>
              <th style={{ textAlign: 'center' }}>Type</th>
              <th style={{ textAlign: 'center' }}>Status</th>
              <th style={{ textAlign: 'center' }}>Total</th>
              <th style={{ textAlign: 'center' }}>Passed</th>
              <th style={{ textAlign: 'center' }}>Failed</th>
              <th style={{ textAlign: 'center' }}>Skipped</th>
              <th style={{ minWidth: 240 }}>Reason / errors</th>
            </tr>
          </thead>
          <tbody>
            {error && (
              <tr>
                <td colSpan={8} className="text-rose-600 text-[13px] py-6 text-center">
                  {error.message}
                </td>
              </tr>
            )}
            {!error && items.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="text-ink-400 text-[13px] py-8 text-center">
                  No uploads yet.
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

  return (
    <tr>
      <td className="text-[12.5px] text-ink-700 whitespace-nowrap">
        <div className="font-semibold">{formatRelative(upload.created_at)}</div>
        <div className="text-[11px] text-ink-400">
          {new Date(upload.created_at).toLocaleString()}
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
      <td className="text-[12px]">
        {upload.status === 'completed' && upload.failed > 0 && upload.errors_csv_s3_key ? (
          <button
            type="button"
            onClick={onDownloadErrors}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-[var(--bd-primary-50)] text-primary-600 font-semibold hover:bg-[var(--bd-primary-100)] disabled:opacity-60"
          >
            <I.download size={12} />
            {downloading ? 'Signing…' : 'errors.csv'}
          </button>
        ) : upload.status === 'completed' ? (
          <span className="text-emerald-600">All rows passed</span>
        ) : upload.status_reason ? (
          <span
            title={upload.status_reason}
            className="text-rose-600 block whitespace-pre-line break-words max-w-[240px] align-middle leading-snug"
          >
            {upload.status_reason.replace(/,\s*/g, ',\n')}
          </span>
        ) : (
          <span className="text-ink-300">—</span>
        )}
      </td>
    </tr>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

interface CreateLinkFormState {
  domain: 'seeker' | 'provider';
  /** Instance (state of operation). Drives slug + display title. */
  state: string;
  /** District — required, drives slug + display title. */
  district: string;
  /** Free-form lever / event label (e.g. "Field Drive", "Bluedotathon"). */
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

function CreateLinkSection() {
  const [form, setForm] = useState<CreateLinkFormState>(EMPTY_FORM);
  const [created, setCreated] = useState<ApiRegistrationLink | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useCreateLink();
  const profile = useProfile();
  const orgName = profile.data?.org ?? '';

  const onCreate = async () => {
    setCreateError(null);
    if (!form.state || !form.district || !form.lever_event) {
      setCreateError('State, District, and Lever / Event are required.');
      return;
    }
    try {
      const title = buildLinkTitle(form);
      const slug = buildLinkSlug(form);
      const link = await create.mutateAsync({
        domain: form.domain,
        status: 'live',
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
      setCreated(link);
    } catch (err) {
      setCreateError((err as Error).message);
    }
  };

  const onCopy = async (value: string) => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-6 py-5 flex items-center gap-3 border-b border-[var(--bd-border)]">
        <I.link size={16} className="text-ink-500" />
        <div className="font-display font-bold text-[16px] text-ink-900">
          Share a registration link
        </div>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11.5px] font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          Live
        </span>
        <div className="ml-auto text-[12px] text-ink-400">
          Slug derived from inputs · QR rendered server-side
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <Field label="Enter your Organisation Name">
              <input
                className="bd-input bg-ink-50 cursor-not-allowed"
                value={orgName}
                readOnly
                placeholder="—"
              />
            </Field>
          </div>
          <Field label="Instance (State Name) *">
            <input
              className="bd-input"
              value={form.state}
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
              placeholder="Karnataka"
            />
          </Field>
          <Field label="Lever / Event">
            <input
              className="bd-input"
              value={form.lever_event}
              onChange={(e) => setForm((f) => ({ ...f, lever_event: e.target.value }))}
              placeholder="Bluedotathon"
            />
          </Field>
          <Field label="Event Date">
            <input
              type="date"
              className="bd-input"
              value={form.event_date}
              onChange={(e) => setForm((f) => ({ ...f, event_date: e.target.value }))}
            />
          </Field>
          <Field label="Event Location">
            <input
              className="bd-input"
              value={form.event_location}
              onChange={(e) => setForm((f) => ({ ...f, event_location: e.target.value }))}
              placeholder="e.g. Hubli"
            />
          </Field>
          <Field label="District *">
            <input
              className="bd-input"
              value={form.district}
              onChange={(e) => setForm((f) => ({ ...f, district: e.target.value }))}
              placeholder="Dharwad"
            />
          </Field>
          <Field label="Domain *">
            <select
              className="bd-input"
              value={form.domain}
              onChange={(e) =>
                setForm((f) => ({ ...f, domain: e.target.value as 'seeker' | 'provider' }))
              }
            >
              <option value="seeker">Seeker</option>
              <option value="provider">Provider</option>
            </select>
          </Field>
          <div className="md:col-span-2 flex items-center justify-end gap-2 mt-2">
            {created ? (
              <>
                <Button
                  kind="ghost"
                  onClick={() => {
                    setForm(EMPTY_FORM);
                    setCreated(null);
                    setCreateError(null);
                  }}
                >
                  + Create another link
                </Button>
                <span className="text-[12px] text-emerald-700 font-semibold">
                  ✓ Added to your list below
                </span>
              </>
            ) : (
              <Button onClick={onCreate} disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create link'}
              </Button>
            )}
          </div>
          {createError && (
            <div className="md:col-span-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2">
              {createError}
            </div>
          )}
          {created && (
            <div className="md:col-span-2 mt-2">
              <div className="bd-label">Public URL</div>
              <div className="flex items-center gap-2 bg-[var(--bd-primary-50)] border border-[var(--bd-primary-100)] rounded-[10px] px-3 py-2.5">
                <I.link size={14} className="text-primary-600" />
                <span className="font-mono text-[12.5px] text-primary-600 truncate flex-1">
                  {created.public_url}
                </span>
                <button
                  type="button"
                  onClick={() => onCopy(created.public_url)}
                  className="text-[12px] font-semibold text-primary-600 inline-flex items-center gap-1 hover:underline"
                >
                  <I.copy size={13} /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="border-t lg:border-t-0 lg:border-l border-[var(--bd-border)] bg-gradient-to-b from-[var(--bd-primary-50)] to-white p-6 flex flex-col items-center text-center">
          <div className="flex items-center gap-2 self-start text-[12.5px] font-semibold text-ink-500">
            <I.qr size={14} /> QR Code
          </div>
          <div className="mt-4 p-3 bg-white rounded-[14px] border border-[var(--bd-border)] bd-shadow-lg">
            {created?.qr_url ? (
              <img
                src={created.qr_url}
                alt="QR code"
                width={200}
                height={200}
                className="w-[200px] h-[200px] object-contain"
              />
            ) : (
              <div className="w-[200px] h-[200px] flex items-center justify-center text-ink-300 text-[12px] text-center px-4">
                Create a link to generate the QR.
              </div>
            )}
          </div>
          {created?.qr_url && (
            <Button
              kind="ghost"
              className="mt-3"
              icon={<I.download size={14} />}
              onClick={() => window.open(created.qr_url ?? '', '_blank', 'noopener,noreferrer')}
            >
              Download QR
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="bd-label">{label}</span>
      {children}
    </label>
  );
}

function LinkCard({ link }: { link: ApiRegistrationLink }) {
  const [copied, setCopied] = useState(false);
  const deactivate = useDeactivateLink();
  const isLive = link.status === 'live';
  const ctx = (link.context ?? {}) as Record<string, unknown>;
  const title =
    (typeof ctx['title'] === 'string' && ctx['title']) ||
    [ctx['district'], ctx['lever_event']].filter(Boolean).join(' ') ||
    link.slug;
  const subtitle =
    [ctx['org_name'], ctx['event_location']].filter(Boolean).join(' · ') ||
    `Created ${new Date(link.created_at).toLocaleDateString()}`;
  // Render `<host>/r/<slug>` as `host/register/org/<slug>` so the slug
  // segment is visually emphasised (the screenshot's design choice).
  let urlHost = link.public_url;
  let urlPath = '';
  try {
    const u = new URL(link.public_url);
    urlHost = u.host;
    urlPath = u.pathname.replace(/^\//, '');
  } catch {
    /* keep raw */
  }
  const onCopy = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(link.public_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
              {isLive ? 'Active' : link.status}
            </span>
          </div>

          <p className="text-[12.5px] text-ink-400 mt-1.5">{subtitle}</p>

          {/* URL row */}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <div className="inline-flex items-center gap-1 bg-ink-50 border border-[var(--bd-border)] rounded-[10px] px-3 py-1.5 text-[12.5px] font-mono">
              <span className="text-ink-500">{urlHost}/</span>
              <span className="text-amber-700 font-semibold">{urlPath}</span>
              <button
                type="button"
                onClick={onCopy}
                title="Copy link"
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
                title="View QR"
                className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-[var(--bd-border)] text-ink-500 hover:text-primary-600 hover:border-[var(--bd-primary-100)]"
              >
                <I.qr size={14} />
              </a>
            )}
            <a
              href={link.public_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open link"
              className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-[var(--bd-border)] text-ink-500 hover:text-primary-600 hover:border-[var(--bd-primary-100)]"
            >
              <I.link size={14} />
            </a>
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[var(--bd-border)] text-ink-600 text-[12.5px] font-semibold hover:bg-ink-50"
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>

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
              <span className="text-ink-400">registrations</span>
            </span>
            <span className="text-ink-700">
              <strong className="font-bold">{link.metrics?.passed ?? 0}</strong>{' '}
              <span className="text-ink-400">verified</span>
            </span>
            <span className="text-ink-400">
              Created {new Date(link.created_at).toLocaleDateString()}
            </span>
            {link.expires_at && (
              <span className="text-ink-400">
                Expires {new Date(link.expires_at).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isLive && (
            <>
              <Button
                kind="ghost"
                onClick={() => deactivate.mutate(link.link_id)}
                disabled={deactivate.isPending}
              >
                {deactivate.isPending ? 'Retiring…' : 'Deactivate'}
              </Button>
              <button
                type="button"
                onClick={() => deactivate.mutate(link.link_id)}
                disabled={deactivate.isPending}
                title="Retire link"
                aria-label="Retire link"
                className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] border border-rose-200 text-rose-500 hover:bg-rose-50 disabled:opacity-50"
              >
                <I.x size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function YourLinks() {
  const [tab, setTab] = useState<'seeker' | 'provider'>('seeker');
  const { data, isLoading, error } = useRegistrationLinks(tab);
  const links: ApiRegistrationLink[] = data ?? [];
  const activeCount = links.filter((l) => l.status === 'live').length;

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between gap-4 border-b border-[var(--bd-border)] flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="font-display font-bold text-[16px] text-primary-600 underline decoration-2 underline-offset-[6px] decoration-[var(--bd-primary)]">
            Your Registration Links
          </h2>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11.5px] font-semibold">
            {activeCount} active
          </span>
        </div>
        <div className="flex items-center bg-ink-50 border border-[var(--bd-border)] rounded-[10px] p-0.5">
          <button
            type="button"
            onClick={() => setTab('seeker')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12.5px] font-semibold transition-all
              ${tab === 'seeker' ? 'bg-white text-amber-700 bd-shadow' : 'text-ink-500 hover:text-ink-700'}`}
          >
            <span className="text-amber-500">●</span> Seeker Links
          </button>
          <button
            type="button"
            onClick={() => setTab('provider')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12.5px] font-semibold transition-all
              ${tab === 'provider' ? 'bg-white text-primary-600 bd-shadow' : 'text-ink-500 hover:text-ink-700'}`}
          >
            <I.briefcase size={12} /> Provider Links
          </button>
        </div>
      </div>
      <div className="p-5 flex flex-col gap-3">
        {isLoading ? (
          <div className="text-center py-10 text-ink-400 text-[13px]">Loading links…</div>
        ) : error ? (
          <div className="text-center py-10 text-rose-600 text-[13px]">
            {(error as Error).message}
          </div>
        ) : links.length === 0 ? (
          <div className="text-center py-10 text-ink-400 text-[13px]">
            No {tab} links yet. Create one above.
          </div>
        ) : (
          links.map((l) => <LinkCard key={l.link_id} link={l} />)
        )}
      </div>
    </div>
  );
}

function UploadStatusBadge({ status }: { status: string }) {
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
      {status}
    </span>
  );
}

export default function OnboardingPage() {
  return (
    <div className="fade-up flex flex-col gap-5">
      <Topbar
        title="Onboarding"
        subtitle="Add participants to your network — by CSV, link, or QR."
      />
      <StatStrip />
      <CSVUpload />
      <CreateLinkSection />
      <YourLinks />
    </div>
  );
}
