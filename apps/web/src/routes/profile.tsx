import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../components/ui/Button';
import { StatusPill } from '../components/ui/StatusPill';
import { SegmentedTabs } from '../components/ui/SegmentedTabs';
import { Topbar } from '../components/shell/Topbar';
import { I } from '../icons';
import { useProfile } from '../hooks/useProfile';
import type { AggregatorProfile } from '../types';

type ProfileTab = 'active' | 'form';

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
  value?: string | undefined;
  mono?: boolean;
}

function KV({ label, value, mono }: KVProps) {
  return (
    <div>
      <div className="text-[11.5px] text-ink-400 font-medium mb-1">{label}</div>
      <div className={`text-[14px] text-ink-900 ${mono ? 'font-mono' : ''}`}>
        {value ? value : <span className="text-ink-300">—</span>}
      </div>
    </div>
  );
}

type DeltaTone = 'up' | 'down' | 'flat';

interface MiniStatProps {
  label: string;
  value: string;
  delta: string;
  deltaTone: DeltaTone;
}

function MiniStat({ label, value, delta, deltaTone }: MiniStatProps) {
  const toneClass: Record<DeltaTone, string> = {
    up: 'text-emerald-600',
    down: 'text-rose-600',
    flat: 'text-ink-400',
  };
  return (
    <div className="rounded-[12px] border border-[var(--bd-border)] bg-white px-4 py-3">
      <div className="text-[11.5px] text-ink-400 font-medium">{label}</div>
      <div className="font-display font-bold text-[20px] text-ink-900 mt-1 leading-none">
        {value}
      </div>
      <div className={`text-[11.5px] font-semibold mt-1 ${toneClass[deltaTone]}`}>{delta}</div>
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
}

function ActiveProfile({ data, isLoading, isError }: ActiveProfileProps) {
  if (isError) {
    return (
      <div className="bd-card bd-shadow p-6 text-[13.5px] text-rose-700 bg-rose-50">
        Failed to load profile. Please try again.
      </div>
    );
  }

  const cardClass = `bd-card bd-shadow overflow-hidden ${isLoading ? 'opacity-60' : ''}`;

  const orgName = data?.org ?? 'TRRAIN';
  const initials = orgName.slice(0, 2).toUpperCase();
  const registered = data?.registered ?? '12 Jan 2025';
  const coordinator = data?.coordinator ?? 'R. Krishnan';
  const aggId = data?.id ?? 'AGG-IND-0142';
  const contactName = data?.contact.name ?? 'R. Krishnan';
  const contactMobile = data?.contact.mobile ?? '+91 98450 22119';
  const contactEmail = data?.contact.email ?? 'r.krishnan@trrain.org';
  const beneficiaries = data?.beneficiaries ?? '';
  const address = data?.address ?? '';
  const geographies = data?.geographies ?? '';
  const sectors = data?.sectors ?? '';
  const network = data?.network;
  const consent = data?.consent;

  return (
    <div className={cardClass}>
      {/* Header */}
      <div className="px-7 py-6 flex items-start justify-between gap-6 bg-gradient-to-r from-[var(--bd-primary-50)] via-white to-white">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-[14px] bg-[var(--bd-brand)] text-white flex items-center justify-center font-display font-bold text-[18px] bd-shadow-lg">
            {initials}
          </div>
          <div>
            <h2 className="font-display font-bold text-[22px] text-ink-900 tracking-tight leading-tight">
              {orgName}
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
        <Button kind="ghost" icon={<I.edit size={14} />}>
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
          <KV label="Beneficiary Groups" value={beneficiaries} />
          <KV label="Organisation Address" value={address} />
          <KV label="Geographies Served" value={geographies} />
          <KV label="Sectors" value={sectors} />
        </div>
      </Section>

      <Section title="Network Snapshot">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MiniStat
            label="Active Seekers"
            value={network ? String(network.activeSeekers) : '58'}
            delta="+12"
            deltaTone="up"
          />
          <MiniStat
            label="Open Roles"
            value={network ? String(network.openRoles) : '77'}
            delta="+18"
            deltaTone="up"
          />
          <MiniStat
            label="Hires (3 mo)"
            value={network ? String(network.hires3mo) : '142'}
            delta="↑ 22%"
            deltaTone="up"
          />
          <MiniStat
            label="Match Rate"
            value={network ? network.matchRate : '34%'}
            delta="vs 28% avg"
            deltaTone="up"
          />
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
          <strong className="text-ink-700 font-medium ml-1">
            {consent?.lastReviewed ?? '02 Apr 2026'}
          </strong>
          . Next review due 02 Apr 2027.
        </div>
      </Section>
    </div>
  );
}

interface FormFieldProps {
  label: string;
  required?: boolean;
  children: ReactNode;
  hint?: string;
  full?: boolean;
}

function FormField({ label, required, children, hint, full }: FormFieldProps) {
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      <label className="bd-label">
        {label}
        {required && <span className="text-rose-500"> *</span>}
      </label>
      {children}
      {hint && <div className="text-[11.5px] text-ink-400 mt-1.5">{hint}</div>}
    </div>
  );
}

interface FormSectionProps {
  num: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

function FormSectionBlock({ num, title, subtitle, children }: FormSectionProps) {
  return (
    <section className="px-7 py-7 border-t border-[var(--bd-border)] first:border-t-0">
      <div className="flex items-start gap-4 mb-5">
        <div className="w-8 h-8 rounded-full bg-[var(--bd-primary-50)] text-primary-600 flex items-center justify-center font-display font-bold text-[13px] shrink-0">
          {num}
        </div>
        <div>
          <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>
          {subtitle && <p className="text-[12.5px] text-ink-400 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="ml-12 grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-4">{children}</div>
    </section>
  );
}

interface ConsentCheckProps {
  defaultChecked?: boolean;
  required?: boolean;
  children: ReactNode;
}

function ConsentCheck({ defaultChecked = true, required, children }: ConsentCheckProps) {
  const [on, setOn] = useState<boolean>(defaultChecked);
  return (
    <div className="flex items-start gap-3 py-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        onClick={() => setOn(!on)}
        className={`w-[18px] h-[18px] rounded-[5px] border-2 flex items-center justify-center mt-0.5 shrink-0 transition-all
              ${
                on
                  ? 'bg-[var(--bd-primary)] border-[var(--bd-primary)]'
                  : 'bg-white border-ink-200 hover:border-ink-300'
              }`}
      >
        {on && <I.check size={11} className="text-white" stroke={3} />}
      </button>
      <span className="text-[13.5px] text-ink-700 leading-relaxed">
        {children} {required && <span className="text-rose-500">*</span>}
      </span>
    </div>
  );
}

function RegistrationForm() {
  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-7 py-5 bg-gradient-to-r from-[var(--bd-primary-50)] to-white border-b border-[var(--bd-border)] flex items-center justify-between">
        <div>
          <h2 className="font-display font-bold text-[17px] text-ink-900">Registration Form</h2>
          <p className="text-[12.5px] text-ink-400 mt-0.5">
            Complete or update the source-of-truth profile for your aggregator.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-ink-400">
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-50 text-amber-700 font-semibold">
            <I.alert size={12} /> Draft saved 4m ago
          </span>
        </div>
      </div>

      <FormSectionBlock num="1" title="Who I Am" subtitle="Tell us about your organisation.">
        <FormField label="Organisation Name" required>
          <input className="bd-input" defaultValue="TRRAIN" />
        </FormField>
        <FormField label="Aggregator Type" required>
          <select className="bd-input appearance-none" defaultValue="Seeker">
            <option>Seeker</option>
            <option>Provider</option>
            <option>Both</option>
          </select>
        </FormField>
        <FormField label="Registration Number">
          <input className="bd-input" defaultValue="AGG-IND-0142" />
        </FormField>
        <FormField label="Established">
          <input className="bd-input" type="date" defaultValue="2011-04-08" />
        </FormField>
        <FormField label="Coordinator Name" required>
          <input className="bd-input" defaultValue="R. Krishnan" />
        </FormField>
        <FormField label="Coordinator Mobile" required>
          <input className="bd-input" defaultValue="+91 98450 22119" />
        </FormField>
        <FormField label="About" full hint="2–3 sentences. Will appear on public profiles.">
          <textarea
            className="bd-input min-h-[88px] resize-y"
            defaultValue="TRRAIN works to elevate retail careers in India by training first-time job seekers and connecting them with verified retail employers across South India."
          />
        </FormField>
      </FormSectionBlock>

      <FormSectionBlock
        num="2"
        title="What I Want"
        subtitle="What kinds of opportunities or candidates are you looking for?"
      >
        <FormField label="Beneficiary Groups" required full>
          <div className="flex flex-wrap gap-2">
            {[
              'Women in retail',
              'First-time job seekers',
              'Persons with disabilities',
              'Rural youth',
              'Returning workforce',
            ].map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bd-primary-50)] text-primary-600 text-[12.5px] font-semibold"
              >
                {t}{' '}
                <button type="button" className="opacity-50 hover:opacity-100">
                  <I.x size={11} />
                </button>
              </span>
            ))}
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed border-ink-200 text-[12px] text-ink-500 hover:border-primary hover:text-primary-600"
            >
              <I.plus size={11} /> Add group
            </button>
          </div>
        </FormField>
        <FormField label="Sectors" required>
          <select className="bd-input appearance-none" defaultValue="Retail">
            <option>Retail</option>
            <option>F&B</option>
            <option>Logistics</option>
            <option>Customer Service</option>
          </select>
        </FormField>
        <FormField label="Target Hires per Quarter">
          <input className="bd-input" defaultValue="120" />
        </FormField>
        <FormField label="Preferred Roles" full>
          <input
            className="bd-input"
            defaultValue="Sales Associate, Cashier, Customer Care Exec, Delivery Partner, Stockroom Asst."
          />
        </FormField>
      </FormSectionBlock>

      <FormSectionBlock num="3" title="What I Have" subtitle="Resources & networks you can offer.">
        <FormField label="Geographies Served" required>
          <input
            className="bd-input"
            defaultValue="Karnataka, Maharashtra, Tamil Nadu, Telangana"
          />
        </FormField>
        <FormField label="Active Network Size">
          <input className="bd-input" defaultValue="2,400 seekers · 86 partner orgs" />
        </FormField>
        <FormField label="Training Programs" full>
          <textarea
            className="bd-input min-h-[68px] resize-y"
            defaultValue="Pankh (60-hr foundation) · Stride (advanced sales) · Saksham (workplace soft-skills)"
          />
        </FormField>
        <FormField label="Office Address" full>
          <input
            className="bd-input"
            defaultValue="2nd Floor, Trade Centre, Bandra-Kurla Complex, Mumbai 400051"
          />
        </FormField>
      </FormSectionBlock>

      <FormSectionBlock
        num="4"
        title="Consent"
        subtitle="Review and confirm. Required items must be accepted to publish."
      >
        <div className="md:col-span-2 flex flex-col gap-1">
          <ConsentCheck required>
            I consent to <strong className="text-ink-900">profile creation & representation</strong>{' '}
            in the Blue Dots ecosystem.
          </ConsentCheck>
          <ConsentCheck required>
            I consent to <strong className="text-ink-900">sharing information</strong> with verified
            relevant parties (seekers, providers, partners).
          </ConsentCheck>
          <ConsentCheck>
            I consent to receive{' '}
            <strong className="text-ink-900">opportunity notifications & nudges</strong> via SMS,
            WhatsApp, and email.
          </ConsentCheck>
          <ConsentCheck>
            I consent to <strong className="text-ink-900">anonymous analytics</strong> for ecosystem
            improvement.
          </ConsentCheck>
          <ConsentCheck defaultChecked={false}>
            I would like to receive marketing from partner organisations.
          </ConsentCheck>
          <ConsentCheck required>
            I confirm data will be retained per{' '}
            <strong className="text-ink-900">Blue Dots policy v2.3</strong>.
          </ConsentCheck>
        </div>
      </FormSectionBlock>

      <div className="px-7 py-5 border-t border-[var(--bd-border)] bg-[var(--bd-bg)] flex items-center justify-between">
        <div className="text-[12.5px] text-ink-400">
          All changes are auto-saved. Submit to publish updates to the ecosystem.
        </div>
        <div className="flex items-center gap-2">
          <Button kind="ghost">Discard</Button>
          <Button kind="ghost">Save draft</Button>
          <Button icon={<I.check size={14} />} disabled>
            Submit for review
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProfileRoute() {
  const [tab, setTab] = useState<ProfileTab>('active');
  const { data, isLoading, isError } = useProfile();

  return (
    <div className="fade-up">
      <Topbar title="Aggregator Profile" subtitle="Manage your aggregator identity and settings." />
      <div className="mb-6">
        <SegmentedTabs<ProfileTab>
          value={tab}
          onChange={setTab}
          items={[
            { id: 'active', label: 'Active Profile' },
            { id: 'form', label: 'Registration Form' },
          ]}
        />
      </div>
      {tab === 'active' ? (
        <ActiveProfile data={data} isLoading={isLoading} isError={isError} />
      ) : (
        <RegistrationForm />
      )}
    </div>
  );
}
