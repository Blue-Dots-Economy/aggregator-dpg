import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { Topbar } from '../components/shell/Topbar';
import { Dropzone } from '../components/ui/Dropzone';
import { QrCode } from '../components/ui/QrCode';
import { I } from '../icons';
import { useRegistrationLinks } from '../hooks/useOnboarding';
import type { RegistrationLink } from '../types';

interface StatItem {
  icon: keyof typeof I;
  label: string;
  count: number;
  tone: string;
  bg: string;
  cta?: boolean;
}

function StatStrip() {
  const items: StatItem[] = [
    {
      icon: 'users',
      label: 'Total registered via your links',
      count: 77,
      tone: '#6366F1',
      bg: '#EEF2FF',
    },
    { icon: 'shield', label: 'Verified & discoverable', count: 77, tone: '#10B981', bg: '#ECFDF5' },
    {
      icon: 'alert',
      label: 'Unverified seekers',
      count: 0,
      tone: '#EF4444',
      bg: '#FEF2F2',
      cta: true,
    },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                {it.count}
              </div>
              <div className="text-[13px] text-ink-500 mt-1.5">{it.label}</div>
            </div>
            {it.cta && (
              <Button kind="ghost" className="!border-rose-200 !text-rose-700 hover:!bg-rose-50">
                Verify Now
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CSVUpload() {
  return (
    <div className="bd-card bd-shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="font-display font-bold text-[16px] text-ink-900">Add participants</div>
          <div className="text-[12.5px] text-ink-400 mt-0.5">
            Bulk upload via CSV — fastest way to import existing rosters.
          </div>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary-600 hover:underline"
        >
          <I.download size={14} /> Download template
        </button>
      </div>

      <Dropzone>
        <div className="w-12 h-12 mx-auto rounded-full bg-white border border-[var(--bd-border)] flex items-center justify-center text-primary-600 mb-3 bd-shadow">
          <I.upload size={20} />
        </div>
        <div className="text-[14px] font-semibold text-ink-700">
          Drag your CSV here or{' '}
          <span className="text-primary-600 underline-offset-2">click to browse</span>
        </div>
        <div className="text-[12px] text-ink-400 mt-1">
          .csv files only · Max 500 rows per upload · UTF-8 encoded
        </div>
      </Dropzone>

      <div className="flex items-center justify-between mt-4">
        <div className="text-[12px] text-ink-400 flex items-center gap-2">
          <I.shield size={14} className="text-emerald-500" /> All uploads are scanned & validated
          before import.
        </div>
        <Button>Upload</Button>
      </div>
    </div>
  );
}

interface FormState {
  org: string;
  state: string;
  lever: string;
  date: string;
  location: string;
  district: string;
  domain: string;
  signal: string;
  sub: string;
  full: string;
  type: string;
}

function RegistrationLinkForm() {
  const [form, setForm] = useState<FormState>({
    org: 'TRRAIN',
    state: 'Karnataka',
    lever: 'Bluedotathon',
    date: '',
    location: '',
    district: 'Dharwad',
    domain: 'Seeker',
    signal: 'Event',
    sub: 'On-ground',
    full: 'TRRAIN-Hubli-2026',
    type: 'Walk-in',
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });

  const url = `https://bluedots.app/r/${(form.org || 'TRRAIN').toLowerCase()}-${(form.state || 'KA')
    .slice(0, 3)
    .toLowerCase()}-${(form.lever || 'event').toLowerCase()}`.replace(/\s+/g, '-');

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
  };

  return (
    <form onSubmit={onSubmit} className="bd-card bd-shadow overflow-hidden">
      <div className="px-6 py-5 flex items-center gap-3 border-b border-[var(--bd-border)]">
        <I.link size={16} className="text-ink-500" />
        <div className="font-display font-bold text-[16px] text-ink-900">
          Share a registration link
        </div>
        <span className="ml-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" /> Live
        </span>
        <div className="ml-auto text-[12px] text-ink-400">Updates instantly · No code required</div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-4">
          <div className="md:col-span-2">
            <label className="bd-label">Organisation Name</label>
            <input
              className="bd-input"
              value={form.org}
              onChange={(e) => set('org', e.target.value)}
            />
          </div>

          <div>
            <label className="bd-label">
              Instance (State Name) <span className="text-rose-500">*</span>
            </label>
            <input
              className="bd-input"
              value={form.state}
              onChange={(e) => set('state', e.target.value)}
            />
          </div>
          <div>
            <label className="bd-label">Lever / Event</label>
            <input
              className="bd-input"
              value={form.lever}
              onChange={(e) => set('lever', e.target.value)}
            />
          </div>

          <div>
            <label className="bd-label">Event Date</label>
            <div className="relative">
              <input
                type="date"
                className="bd-input pr-10"
                value={form.date}
                onChange={(e) => set('date', e.target.value)}
              />
              <I.calendar
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-300 pointer-events-none"
              />
            </div>
          </div>
          <div>
            <label className="bd-label">Event Location</label>
            <input
              className="bd-input"
              placeholder="e.g. Hubli"
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
            />
          </div>

          <div>
            <label className="bd-label">
              District <span className="text-rose-500">*</span>
            </label>
            <input
              className="bd-input"
              value={form.district}
              onChange={(e) => set('district', e.target.value)}
            />
          </div>
          <div>
            <label className="bd-label">
              Domain <span className="text-rose-500">*</span>
            </label>
            <select
              className="bd-input appearance-none"
              value={form.domain}
              onChange={(e) => set('domain', e.target.value)}
            >
              <option>Seeker</option>
              <option>Provider</option>
              <option>Both</option>
            </select>
          </div>

          <div>
            <label className="bd-label">Signal Source</label>
            <select
              className="bd-input appearance-none"
              value={form.signal}
              onChange={(e) => set('signal', e.target.value)}
            >
              <option>Event</option>
              <option>Outreach</option>
              <option>Partner</option>
              <option>Walk-in</option>
            </select>
          </div>
          <div>
            <label className="bd-label">Signal Sub-Source</label>
            <select
              className="bd-input appearance-none"
              value={form.sub}
              onChange={(e) => set('sub', e.target.value)}
            >
              <option>On-ground</option>
              <option>Online</option>
              <option>Referral</option>
            </select>
          </div>

          <div>
            <label className="bd-label">Source Full Name</label>
            <input
              className="bd-input"
              value={form.full}
              onChange={(e) => set('full', e.target.value)}
            />
          </div>
          <div>
            <label className="bd-label">Source Type</label>
            <select
              className="bd-input appearance-none"
              value={form.type}
              onChange={(e) => set('type', e.target.value)}
            >
              <option>Walk-in</option>
              <option>Campaign</option>
              <option>Referral</option>
              <option>Direct</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="bd-label">Generated URL</label>
            <div className="flex items-center gap-2 bg-[var(--bd-primary-50)] border border-[var(--bd-primary-100)] rounded-[10px] px-3 py-2.5">
              <I.link size={14} className="text-primary-600" />
              <span className="font-mono text-[12.5px] text-primary-600 truncate flex-1">
                {url}
              </span>
              <button
                type="button"
                className="text-[12px] font-semibold text-primary-600 inline-flex items-center gap-1 hover:underline"
              >
                <I.copy size={13} /> Copy
              </button>
            </div>
          </div>
        </div>

        {/* QR side panel */}
        <div className="border-t lg:border-t-0 lg:border-l border-[var(--bd-border)] bg-gradient-to-b from-[var(--bd-primary-50)] to-white p-6 flex flex-col items-center text-center">
          <div className="flex items-center gap-2 self-start text-[12.5px] font-semibold text-ink-500">
            <I.qr size={14} /> QR Code
          </div>

          <div className="mt-4 p-3 bg-white rounded-[14px] border border-[var(--bd-border)] bd-shadow-lg relative">
            <QrCode />
            <div className="absolute -top-2 -right-2 bg-[var(--bd-brand)] text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
              LIVE
            </div>
          </div>

          <div className="text-[12px] text-ink-400 mt-4 max-w-[220px]">
            Scan or click to open registration page. Refreshes whenever you edit the form.
          </div>

          <Button kind="ghost" className="mt-3" icon={<I.download size={14} />}>
            Download QR
          </Button>

          <div className="rail-divider w-full my-5" />

          <div className="self-stretch text-left">
            <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-ink-300 mb-2">
              Live preview
            </div>
            <div className="text-[12.5px] text-ink-500">
              <span className="font-semibold text-ink-700">{form.org}</span> · {form.state}
              <br />
              {form.lever} · {form.district}
              <br />
              <span className="text-ink-400">{form.full}</span>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

interface LinkCardProps {
  link: RegistrationLink;
}

function LinkCard({ link }: LinkCardProps) {
  const [copied, setCopied] = useState(false);
  const url = `bluedots.in/register/org/${link.slug}`;
  const onCopy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="bd-card p-5 hover:border-[var(--bd-primary-100)] transition-colors group">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-[15.5px] text-ink-900 leading-tight">
              {link.title}
            </h3>
            {link.active && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" /> Active
              </span>
            )}
          </div>
          <p className="text-[12.5px] text-ink-400 mt-1.5">{link.desc}</p>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <div className="inline-flex items-center gap-2 bg-ink-50 border border-[var(--bd-border)] rounded-[10px] px-3 py-1.5 text-[12.5px]">
              <span className="text-ink-400">{url.split('/').slice(0, -1).join('/')}/</span>
              <span className="font-mono text-rose-500">{link.slug}</span>
              <button type="button" className="ml-1 text-ink-300 hover:text-ink-700">
                <I.copy size={12} />
              </button>
            </div>
            <button
              type="button"
              className="w-8 h-8 rounded-[10px] border border-[var(--bd-border)] bg-white hover:bg-ink-50 flex items-center justify-center text-ink-500"
              title="QR code"
            >
              <I.qr size={14} />
            </button>
            <button
              type="button"
              className="w-8 h-8 rounded-[10px] border border-[var(--bd-border)] bg-white hover:bg-ink-50 flex items-center justify-center text-ink-500"
              title="Open"
            >
              <I.link size={14} />
            </button>
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-[var(--bd-primary-50)] text-primary-600 text-[12.5px] font-semibold hover:bg-[var(--bd-primary-100)] transition-colors"
            >
              <I.copy size={12} /> {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>

          <div className="flex items-center gap-4 mt-3.5 text-[12.5px] flex-wrap">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-semibold text-[11.5px]">
              {link.kind}
            </span>
            <span className="text-ink-700">
              <strong className="font-display font-bold tabular-nums">{link.regs}</strong>{' '}
              <span className="text-ink-400">registrations</span>
            </span>
            <span className="text-ink-700">
              <strong className="font-display font-bold tabular-nums text-emerald-600">
                {link.verified}
              </strong>{' '}
              <span className="text-ink-400">verified</span>
            </span>
            <span className="text-ink-400">Last used {link.last}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button kind="ghost">Deactivate</Button>
          <button
            type="button"
            className="w-8 h-8 rounded-[10px] border border-rose-200 text-rose-500 hover:bg-rose-50 flex items-center justify-center"
            title="Delete link"
          >
            <I.x size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function YourLinks() {
  const [tab, setTab] = useState<'seeker' | 'provider'>('seeker');
  const { data: links } = useRegistrationLinks(tab);
  const list: RegistrationLink[] = links ?? [];
  const activeCount = list.filter((l) => l.active).length;

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
        {!links ? (
          <div className="text-center py-10 text-ink-400 text-[13px]" />
        ) : list.length === 0 ? (
          <div className="text-center py-10 text-ink-400 text-[13px]">
            No {tab} links yet. Create one above.
          </div>
        ) : (
          list.map((l) => <LinkCard key={l.id} link={l} />)
        )}
      </div>
    </div>
  );
}

function FlaggedProfiles() {
  const flaggedCount = 0;
  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--bd-border)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="font-display font-bold text-[15px] text-ink-900">Flagged profiles</h2>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 text-[11.5px] font-semibold">
            <I.alert size={11} /> {flaggedCount}
          </span>
        </div>
        <button
          type="button"
          className="text-[12px] font-semibold text-primary-600 hover:underline"
        >
          Review guidelines
        </button>
      </div>
      <div className="overflow-x-auto scroll-x">
        <table className="bd-table" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Issue</th>
              <th>Upload date</th>
              <th>Days flagged</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={6} style={{ padding: '48px 14px' }}>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
                    <I.check size={20} stroke={2.4} />
                  </div>
                  <div className="text-[13.5px] font-semibold text-ink-700">
                    No flagged profiles
                  </div>
                  <div className="text-[12px] text-ink-400">
                    All uploaded participants pass validation. Nice work.
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OnboardingRoute() {
  return (
    <div className="fade-up flex flex-col gap-5">
      <Topbar
        title="Onboarding"
        subtitle="Add participants to your network — by CSV, link, or QR."
        right={
          <div className="flex items-center gap-2">
            <Button kind="ghost" icon={<I.refresh size={14} />}>
              Sync now
            </Button>
            <Button icon={<I.plus size={14} />}>New campaign</Button>
          </div>
        }
      />
      <StatStrip />
      <CSVUpload />
      <RegistrationLinkForm />
      <YourLinks />
      <FlaggedProfiles />
    </div>
  );
}
