'use client';

/**
 * Screens a coordinator page shows instead of its content when the
 * coordinator's profile types are not usable: the profile failed to load, or
 * the coordinator has no profile types.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CloudOff, LogOut, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/PageLoading';
import { useActiveDomain } from '@/hooks/useActiveDomain';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';

/** Props for {@link AccessCard}. */
interface AccessCardProps {
  tone: 'amber' | 'rose';
  icon: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
  /** Extra content under the actions. */
  footer?: ReactNode;
  /** `alert` announces the card to screen readers when it appears. */
  role?: 'alert' | 'status';
}

const TONE = {
  amber: { bg: 'var(--bd-tint-amber)', ring: 'bg-amber-100 text-amber-600' },
  rose: { bg: 'var(--bd-tint-rose)', ring: 'bg-rose-100 text-rose-600' },
} as const;

/** Centred card with an icon, a title, a short explanation and actions. */
function AccessCard({ tone, icon, title, body, children, footer, role }: AccessCardProps) {
  return (
    <section
      role={role}
      aria-labelledby="access-card-title"
      className="bd-card bd-shadow mx-auto mt-8 w-full max-w-xl overflow-hidden"
    >
      <div
        className="flex flex-col items-center gap-3 px-6 pt-10 pb-6 text-center sm:px-10"
        style={{ background: `linear-gradient(180deg, ${TONE[tone].bg} 0%, var(--bd-card) 70%)` }}
      >
        <span
          className={cn('grid h-14 w-14 place-items-center rounded-full', TONE[tone].ring)}
          aria-hidden="true"
        >
          {icon}
        </span>
        <h2 id="access-card-title" className="font-display text-[20px] font-bold text-ink-900">
          {title}
        </h2>
        <p className="max-w-md text-[14px] leading-relaxed text-ink-500">{body}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>
      </div>
      {footer ? (
        <div className="border-t border-(--bd-border) px-6 py-4 text-[13px] text-ink-500 sm:px-10">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** Props for {@link ProfileLoadError}. */
export interface ProfileLoadErrorProps {
  /** Loads the profile again. */
  onRetry: () => void;
  /** `true` while the retry is in flight. */
  retrying: boolean;
}

/**
 * Shown when the profile or the network config failed to load. The
 * coordinator's access is unknown, so no content is shown.
 */
export function ProfileLoadError({ onRetry, retrying }: Readonly<ProfileLoadErrorProps>) {
  const t = useTranslations('access.load_error');
  return (
    <AccessCard
      tone="rose"
      role="alert"
      icon={<CloudOff size={26} />}
      title={t('title')}
      body={t('body')}
    >
      <Button
        onClick={onRetry}
        disabled={retrying}
        aria-busy={retrying}
        icon={<RefreshCw size={15} className={retrying ? 'animate-spin' : undefined} />}
      >
        {retrying ? t('retrying') : t('retry')}
      </Button>
      <Button kind="ghost" onClick={() => window.location.reload()}>
        {t('reload')}
      </Button>
    </AccessCard>
  );
}

/**
 * Shown when the coordinator has no profile types. The API refuses every
 * participant read and write for them until an admin sets the types.
 */
export function NoProfileTypesNotice() {
  const t = useTranslations('access.no_profile_types');
  const { user, signOut } = useAuth();
  const account = user?.email ?? user?.phone;
  return (
    <AccessCard
      tone="amber"
      role="status"
      icon={<ShieldAlert size={26} />}
      title={t('title')}
      body={t('body')}
      footer={
        <>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5">
            <li>{t('step_contact')}</li>
            <li>{t('step_sign_in')}</li>
          </ol>
          {account ? (
            <p className="mt-3 text-[12.5px] text-ink-400">
              {t('signed_in_as')} <span className="font-semibold text-ink-700">{account}</span>
            </p>
          ) : null}
        </>
      }
    >
      <Button icon={<LogOut size={15} />} onClick={() => void signOut()}>
        {t('sign_out')}
      </Button>
    </AccessCard>
  );
}

/** Props for {@link DomainAccessGate}. */
export interface DomainAccessGateProps {
  children: ReactNode;
  /** Shown while the profile loads. Defaults to the loading text. */
  loading?: ReactNode;
}

/**
 * Renders `children` only when the coordinator's profile has loaded and they
 * have at least one profile type. Otherwise renders the load error, the
 * loading state or {@link NoProfileTypesNotice}.
 */
export function DomainAccessGate({ children, loading }: Readonly<DomainAccessGateProps>) {
  const { ready, error, retry, retrying, domains } = useActiveDomain();
  if (error) return <ProfileLoadError onRetry={retry} retrying={retrying} />;
  if (!ready) return <>{loading ?? <PageLoading />}</>;
  if (domains.length === 0) return <NoProfileTypesNotice />;
  return <>{children}</>;
}
