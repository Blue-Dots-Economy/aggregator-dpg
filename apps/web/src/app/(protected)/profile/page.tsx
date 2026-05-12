'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Topbar } from '../../../components/shell/Topbar';
import { Button } from '../../../components/ui/Button';
import { StatusPill } from '../../../components/ui/StatusPill';
import { useProfile } from '../../../hooks/useProfile';
import type { AggregatorProfile } from '../../../types';
import { I } from '../../../icons';
import { ProfileEditView } from './ProfileEditView';

type DeltaTone = 'up' | 'down' | 'flat';

interface MiniStatProps {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: DeltaTone;
}

function MiniStat({ label, value, delta, deltaTone = 'up' }: MiniStatProps) {
  const toneClass =
    deltaTone === 'up'
      ? 'text-emerald-600'
      : deltaTone === 'down'
        ? 'text-rose-600'
        : 'text-ink-400';
  return (
    <div className="rounded-[12px] border border-[var(--bd-border)] bg-white px-4 py-3">
      <div className="text-[11.5px] text-ink-400 font-medium">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="font-display font-bold text-[20px] text-ink-900 leading-none">{value}</div>
        {delta && <div className={`text-[11.5px] font-semibold ${toneClass}`}>{delta}</div>}
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}

function Section({ title, children, right }: SectionProps) {
  return (
    <section className="px-7 py-6 border-t border-[var(--bd-border)] first:border-t-0">
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-400">
          {title}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

interface KVProps {
  label: string;
  value?: ReactNode;
  mono?: boolean;
}

function KV({ label, value, mono }: KVProps) {
  return (
    <div>
      <div className="text-[11.5px] text-ink-400 font-medium mb-1">{label}</div>
      <div className={`text-[14px] text-ink-900 ${mono ? 'font-mono' : ''}`}>
        {value !== undefined && value !== null && value !== '' ? (
          value
        ) : (
          <span className="text-ink-300">—</span>
        )}
      </div>
    </div>
  );
}

interface ConsentRowProps {
  checked?: boolean;
  children: ReactNode;
}

function ConsentRow({ checked = true, children }: ConsentRowProps) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className={`tick mt-0.5 ${!checked ? '!bg-ink-100 !text-ink-300' : ''}`}>
        {checked ? <I.check size={11} /> : <I.x size={11} />}
      </span>
      <div className="text-[13.5px] text-ink-700 leading-relaxed">{children}</div>
    </div>
  );
}

interface ActiveProfileProps {
  data: AggregatorProfile | undefined;
  isLoading: boolean;
  isError: boolean;
  onEdit: () => void;
}

function ActiveProfile({ data, isLoading, isError, onEdit }: ActiveProfileProps) {
  if (isError) {
    return (
      <div className="bd-card bd-shadow overflow-hidden border border-rose-200 bg-rose-50 px-7 py-6">
        <div className="flex items-start gap-3">
          <I.alert size={18} className="text-rose-600 mt-0.5" />
          <div>
            <div className="font-display font-bold text-[15px] text-rose-700">
              Could not load profile
            </div>
            <div className="text-[13px] text-rose-600 mt-1">
              We hit an error fetching the aggregator profile. Please try again shortly.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const org = data?.org ?? 'TRRAIN';
  const registered = data?.registered ?? '12 Jan 2025';
  const coordinator = data?.coordinator ?? 'R. Krishnan';
  const aggId = data?.id ?? 'AGG-IND-0142';
  const contactName = data?.contact.name ?? 'R. Krishnan';
  const contactMobile = data?.contact.mobile ?? '+91 98450 22119';
  const contactEmail = data?.contact.email ?? 'r.krishnan@trrain.org';
  const beneficiaries =
    data?.beneficiaries ?? 'Women in retail · First-time job seekers · Persons with disabilities';
  const address = data?.address ?? '2nd Floor, Trade Centre, Bandra-Kurla Complex, Mumbai 400051';
  const geographies = data?.geographies ?? 'Karnataka, Maharashtra, Tamil Nadu, Telangana';
  const sectors = data?.sectors ?? 'Retail · F&B · Customer Service · Logistics';
  const activeSeekers = data?.network.activeSeekers ?? 58;
  const openRoles = data?.network.openRoles ?? 77;
  const hires3mo = data?.network.hires3mo ?? 142;
  const matchRate = data?.network.matchRate ?? '34%';
  const consent = data?.consent;
  const consentLastReviewed = consent?.lastReviewed ?? '02 Apr 2026';

  const initials = org
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={`bd-card bd-shadow overflow-hidden ${isLoading ? 'opacity-60' : ''}`}>
      <div className="px-7 py-6 flex items-start justify-between gap-6 bg-gradient-to-r from-[var(--bd-primary-50)] via-white to-white">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-[14px] bg-[var(--bd-brand)] text-white flex items-center justify-center font-display font-bold text-[18px] bd-shadow-lg">
            {initials}
          </div>
          <div>
            <h2 className="font-display font-bold text-[22px] text-ink-900 tracking-tight leading-tight">
              {org}
            </h2>
            <div className="flex items-center gap-2 mt-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11.5px] font-semibold bg-[var(--bd-primary-50)] text-primary-600">
                <I.users size={11} /> Aggregator
              </span>
              <StatusPill status="active" />
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11.5px] font-semibold bg-emerald-50 text-emerald-700">
                <I.shield size={11} /> Verified
              </span>
            </div>
            <div className="text-[12.5px] text-ink-400 mt-2.5 flex items-center gap-3">
              <span>
                Registered <strong className="text-ink-700 font-medium">{registered}</strong>
              </span>
              <span className="text-ink-200">·</span>
              <span>
                Coordinator <strong className="text-ink-700 font-medium">{coordinator}</strong>
              </span>
              <span className="text-ink-200">·</span>
              <span className="font-mono">{aggId}</span>
            </div>
          </div>
        </div>
        <Button kind="ghost" icon={<I.edit size={14} />} onClick={onEdit}>
          Edit
        </Button>
      </div>

      <Section title="Contact Information">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <KV label="Name" value={contactName} />
          <KV label="Mobile" value={contactMobile} mono />
          <KV label="Email" value={contactEmail} />
        </div>
        <div className="mt-5">
          <div className="text-[11.5px] text-ink-400 font-medium mb-2">Preferred Contact Mode</div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--bd-primary-50)] text-primary-600 text-[12.5px] font-semibold">
            <I.phone size={12} /> Contact me first
          </div>
        </div>
      </Section>

      <Section title="Aggregator Details">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          <KV label="Organisation Address" value={address} />
          <KV label="Geographies Served" value={geographies} />
        </div>
      </Section>

      <Section title="Personas Supported">
        <div className="text-[14px] text-ink-900">
          {beneficiaries ? (
            <div className="flex flex-wrap gap-2">
              {beneficiaries.split(' · ').map((p, i) => (
                <span
                  key={i}
                  className="inline-flex items-center px-2.5 py-1 rounded-full bg-[var(--bd-primary-50)] text-primary-600 text-[12.5px] font-semibold"
                >
                  {p}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-ink-300">—</span>
          )}
        </div>
      </Section>

      <Section title="Services Supported">
        <div className="text-[14px] text-ink-900">
          {sectors ? (
            <div className="flex flex-wrap gap-2">
              {sectors.split(' · ').map((s, i) => (
                <span
                  key={i}
                  className="inline-flex items-center px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-[12.5px] font-semibold"
                >
                  {s}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-ink-300">—</span>
          )}
        </div>
      </Section>

      <Section title="Network Snapshot">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MiniStat
            label="Active Seekers"
            value={String(activeSeekers)}
            delta="+12"
            deltaTone="up"
          />
          <MiniStat label="Open Roles" value={String(openRoles)} delta="+18" deltaTone="up" />
          <MiniStat label="Hires (3 mo)" value={String(hires3mo)} delta="↑ 22%" deltaTone="up" />
          <MiniStat label="Match Rate" value={matchRate} delta="vs 28% avg" deltaTone="up" />
        </div>
      </Section>

      <Section
        title="Consent & Compliance"
        right={
          <button
            type="button"
            className="text-[12px] font-semibold text-primary-600 hover:underline"
          >
            Review history
          </button>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10">
          <ConsentRow checked={consent?.profileCreation ?? true}>
            Profile creation & representation in the ecosystem
          </ConsentRow>
          <ConsentRow checked={consent?.sharing ?? true}>
            Sharing information with relevant parties
          </ConsentRow>
          <ConsentRow checked={consent?.notifications ?? true}>
            Receive opportunity notifications & nudges
          </ConsentRow>
          <ConsentRow checked={consent?.analytics ?? true}>
            Anonymous analytics for ecosystem improvement
          </ConsentRow>
          <ConsentRow checked={consent?.marketing ?? false}>
            Marketing communication from partner orgs
          </ConsentRow>
          <ConsentRow checked={consent?.retention ?? true}>
            Data retention per Blue Dots policy v2.3
          </ConsentRow>
        </div>
        <div className="mt-5 flex items-center gap-2 text-[12px] text-ink-400">
          <I.shield size={14} className="text-emerald-500" />
          Last consent reviewed{' '}
          <strong className="text-ink-700 font-medium ml-1">{consentLastReviewed}</strong>. Next
          review due 02 Apr 2027.
        </div>
      </Section>
    </div>
  );
}

function SavedToast({ onDone }: { onDone: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [onDone]);
  if (!mounted) return null;
  // Portal to <body> so the toast is not contained by any ancestor with a
  // CSS `transform` (e.g. the `fade-up` animation wrapper), which would turn
  // `position: fixed` into "fixed-to-ancestor" instead of "fixed-to-viewport".
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 right-4 z-[100] rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 shadow-lg inline-flex items-center gap-2"
    >
      <I.check size={14} /> Profile saved
    </div>,
    document.body,
  );
}

export default function ProfilePage() {
  const [isEditing, setIsEditing] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const { data, isLoading, isError } = useProfile();

  return (
    <div className="fade-up">
      <Topbar title="Aggregator Profile" subtitle="Manage your aggregator identity and settings." />
      {isEditing ? (
        <ProfileEditView
          onDone={() => setIsEditing(false)}
          onSaved={() => {
            setIsEditing(false);
            setShowToast(true);
          }}
        />
      ) : (
        <ActiveProfile
          data={data}
          isLoading={isLoading}
          isError={isError}
          onEdit={() => setIsEditing(true)}
        />
      )}
      {showToast && <SavedToast onDone={() => setShowToast(false)} />}
    </div>
  );
}
