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
        label: 'Total registered via your links',
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
        <label htmlFor="csv-file-input" className="cursor-pointer block text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-white border border-[var(--bd-border)] flex items-center justify-center text-primary-600 mb-3 bd-shadow">
            <I.upload size={20} />
          </div>
          <div className="text-[14px] font-semibold text-ink-700">
            {pickedFile ? (
              <span className="text-primary-600">{pickedFile.name}</span>
            ) : (
              <>
                Drag your CSV here or{' '}
                <span className="text-primary-600 underline-offset-2">click to browse</span>
              </>
            )}
          </div>
          <div className="text-[12px] text-ink-400 mt-1">
            .csv only · UTF-8 encoded · uploaded as {participantType}s
          </div>
        </label>
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
        error={recent.error as Error | null}
      />
    </div>
  );
}

function RecentUploadsTable({
  items,
  loading,
  error,
}: {
  items: BulkUploadStatus[];
  loading: boolean;
  error: Error | null;
}) {
  return (
    <div className="mt-5 border-t border-[var(--bd-border)] pt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-display font-bold text-[14px] text-ink-700">Recent uploads</div>
        <div className="text-[11.5px] text-ink-400">
          {loading ? 'Loading…' : 'Refreshes while jobs are in-flight'}
        </div>
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
              <th>Reason / errors</th>
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
        {upload.status === 'completed' ? (
          <button
            type="button"
            onClick={onDownloadErrors}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-[var(--bd-primary-50)] text-primary-600 font-semibold hover:bg-[var(--bd-primary-100)] disabled:opacity-60"
          >
            <I.download size={12} />
            {downloading ? 'Signing…' : 'errors.csv'}
          </button>
        ) : upload.status_reason ? (
          <span
            title={upload.status_reason}
            className="text-rose-600 truncate inline-block max-w-[220px] align-middle"
          >
            {upload.status_reason}
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
  state: string;
  district: string;
  signal_source: string;
  campaign: string;
}

const EMPTY_FORM: CreateLinkFormState = {
  domain: 'seeker',
  state: '',
  district: '',
  signal_source: '',
  campaign: '',
};

function CreateLinkSection() {
  const [form, setForm] = useState<CreateLinkFormState>(EMPTY_FORM);
  const [created, setCreated] = useState<ApiRegistrationLink | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useCreateLink();

  const onCreate = async () => {
    setCreateError(null);
    try {
      const link = await create.mutateAsync({
        domain: form.domain,
        status: 'live',
        context: {
          state: form.state || undefined,
          district: form.district || undefined,
          signal_source: form.signal_source || undefined,
          campaign: form.campaign || undefined,
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
        <div className="ml-auto text-[12px] text-ink-400">
          Generated by API · QR rendered server-side
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Domain">
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
          <Field label="State">
            <input
              className="bd-input"
              value={form.state}
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
              placeholder="Karnataka"
            />
          </Field>
          <Field label="District">
            <input
              className="bd-input"
              value={form.district}
              onChange={(e) => setForm((f) => ({ ...f, district: e.target.value }))}
              placeholder="Bangalore"
            />
          </Field>
          <Field label="Signal source">
            <input
              className="bd-input"
              value={form.signal_source}
              onChange={(e) => setForm((f) => ({ ...f, signal_source: e.target.value }))}
              placeholder="event"
            />
          </Field>
          <Field label="Campaign">
            <input
              className="bd-input"
              value={form.campaign}
              onChange={(e) => setForm((f) => ({ ...f, campaign: e.target.value }))}
              placeholder="march-camp"
            />
          </Field>
          <div className="md:col-span-2 flex items-center justify-end mt-2">
            <Button onClick={onCreate} disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create link'}
            </Button>
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
  const onCopy = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(link.public_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="bd-card p-5 hover:border-[var(--bd-primary-100)] transition-colors group">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-[15.5px] text-ink-900 leading-tight">
              {link.slug}
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
              {link.status}
            </span>
          </div>
          <p className="text-[12.5px] text-ink-400 mt-1.5">
            {summariseContext(link.context) || 'No context fields set.'}
          </p>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <div className="inline-flex items-center gap-2 bg-ink-50 border border-[var(--bd-border)] rounded-[10px] px-3 py-1.5 text-[12.5px]">
              <span className="font-mono text-rose-500">{link.public_url}</span>
            </div>
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-[var(--bd-primary-50)] text-primary-600 text-[12.5px] font-semibold hover:bg-[var(--bd-primary-100)] transition-colors"
            >
              <I.copy size={12} /> {copied ? 'Copied!' : 'Copy link'}
            </button>
            {link.qr_url && (
              <a
                href={link.qr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[var(--bd-border)] text-ink-600 text-[12.5px] font-semibold hover:bg-ink-50"
              >
                <I.qr size={12} /> QR
              </a>
            )}
          </div>

          <div className="flex items-center gap-4 mt-3.5 text-[12.5px] flex-wrap">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-semibold text-[11.5px]">
              {link.domain}
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
            <Button
              kind="ghost"
              onClick={() => deactivate.mutate(link.link_id)}
              disabled={deactivate.isPending}
            >
              {deactivate.isPending ? 'Retiring…' : 'Deactivate'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function summariseContext(context: Record<string, unknown>): string {
  return Object.entries(context)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
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
            {activeCount} live
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
