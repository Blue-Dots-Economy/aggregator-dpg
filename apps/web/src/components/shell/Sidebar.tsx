import { NavLink } from 'react-router-dom';
import { I, type IconName } from '../../icons';
import { BlueDotsLogo } from '../ui/BlueDotsLogo';
import { useAuth } from '../../lib/auth-context';
import { cn } from '../../lib/cn';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  badge?: number;
}

const NAV: NavItem[] = [
  { to: '/blue-dots', label: 'My Blue Dots', icon: 'users', badge: 77 },
  { to: '/onboarding', label: 'Onboarding', icon: 'upload' },
  { to: '/profile', label: 'Profile', icon: 'user' },
];

interface ActivityItem {
  who: string;
  what: string;
  when: string;
  tone: 'green' | 'blue' | 'amber';
  type: 'placed' | 'profile' | 'risk';
}

const ACTIVITY: ActivityItem[] = [
  {
    type: 'placed',
    who: 'Priya S.',
    what: 'placed at Reliance Retail',
    when: '12m',
    tone: 'green',
  },
  { type: 'profile', who: 'Arjun K.', what: 'completed profile', when: '34m', tone: 'blue' },
  { type: 'risk', who: 'Meera J.', what: 'marked at-risk', when: '1h', tone: 'amber' },
];

const TONES: Record<ActivityItem['tone'], { bg: string; dot: string }> = {
  green: { bg: 'rgba(16,185,129,0.12)', dot: '#10B981' },
  blue: { bg: 'rgba(37,99,235,0.12)', dot: '#2563EB' },
  amber: { bg: 'rgba(245,158,11,0.14)', dot: '#F59E0B' },
};

function ActivityIconShape({ type }: { type: ActivityItem['type'] }) {
  if (type === 'placed') return <path d="M20 6 9 17l-5-5" />;
  if (type === 'profile')
    return (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 21a7 7 0 0 1 14 0" />
      </>
    );
  return (
    <>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </>
  );
}

function ActivityRow({ who, what, when, tone, type }: ActivityItem) {
  const t = TONES[tone];
  return (
    <button
      type="button"
      className="group flex items-start gap-2 px-3 py-1.5 rounded-[8px] text-left transition-colors hover:bg-ink-50/70"
    >
      <div
        className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: t.bg }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke={t.dot}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <ActivityIconShape type={type} />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] text-ink-700 leading-tight truncate">
          <span className="font-semibold text-ink-900">{who}</span>{' '}
          <span className="text-ink-500">{what}</span>
        </div>
        <div className="text-[10px] text-ink-400 mt-0.5">{when} ago</div>
      </div>
    </button>
  );
}

export function Sidebar() {
  const { user, signOut } = useAuth();
  const orgInitials = (user?.org ?? 'TR').slice(0, 2).toUpperCase();

  return (
    <aside className="w-[252px] shrink-0 bg-white border-r border-[var(--bd-border)] flex flex-col h-screen sticky top-0">
      <div className="px-5 pt-6 pb-5">
        <div className="flex items-center gap-3">
          <BlueDotsLogo size={40} />
          <div>
            <div className="font-display font-bold text-[17px] text-ink-900 leading-tight">
              Blue Dots
            </div>
            <div className="text-[12px] text-ink-400 leading-tight mt-0.5">Aggregator Portal</div>
          </div>
        </div>
      </div>

      <div className="px-3">
        <div className="px-3 pt-3 pb-2 text-[10.5px] uppercase tracking-[0.12em] font-semibold text-ink-300">
          Overview
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => {
            const Ic = I[n.icon];
            return (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cn(
                    'group flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-[14px] font-medium transition-all',
                    isActive ? 'nav-active' : 'text-ink-500 hover:bg-ink-50 hover:text-ink-900',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Ic size={18} stroke={isActive ? 2 : 1.7} />
                    <span>{n.label}</span>
                    {n.badge !== undefined && (
                      <span
                        className={cn(
                          'ml-auto text-[11px] font-semibold px-1.5 py-0.5 rounded-md',
                          isActive ? 'bg-white text-primary-600' : 'bg-ink-100 text-ink-500',
                        )}
                      >
                        {n.badge}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>
      </div>

      <div className="px-3 mt-5 min-h-0 flex flex-col overflow-hidden">
        <div className="px-3 pt-2 pb-1.5 flex items-center justify-between">
          <div className="text-[10.5px] uppercase tracking-[0.12em] font-semibold text-ink-300">
            Recent activity
          </div>
          <button
            type="button"
            className="text-[10.5px] font-semibold text-primary-600 hover:underline"
          >
            View all
          </button>
        </div>
        <div className="flex flex-col">
          {ACTIVITY.map((a, i) => (
            <ActivityRow key={i} {...a} />
          ))}
        </div>
      </div>

      <div className="mt-auto p-3 shrink-0">
        <div className="rounded-[12px] bg-gradient-to-br from-[var(--bd-primary-50)] to-white border border-[var(--bd-border)] p-3 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[var(--bd-brand)] text-white flex items-center justify-center font-display font-bold text-[12px] shrink-0">
            {orgInitials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ink-900 truncate">
              {user?.org ?? 'TRRAIN'}
            </div>
            <div className="text-[11px] text-ink-400 truncate">Aggregator · Karnataka</div>
          </div>
          <button
            type="button"
            onClick={() => {
              void signOut();
            }}
            title="Sign Out"
            aria-label="Sign out"
            className="w-7 h-7 rounded-md flex items-center justify-center text-ink-400 hover:bg-white hover:text-rose-600 transition-colors shrink-0"
          >
            <I.signout size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
