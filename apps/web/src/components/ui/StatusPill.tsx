import type { ProfileStatus, ParticipantStatus } from '../../types';

type Status = ParticipantStatus | ProfileStatus;

interface StatusConfig {
  dot: string;
  bg: string;
  text: string;
  label: string;
  pulse?: boolean;
}

const MAP: Record<Status, StatusConfig> = {
  active: { dot: '#10B981', bg: '#ECFDF5', text: '#047857', label: 'Active' },
  'at-risk': {
    dot: '#F59E0B',
    bg: '#FFFBEB',
    text: '#B45309',
    label: 'At Risk',
    pulse: true,
  },
  inactive: { dot: '#94A3B8', bg: '#F1F5F9', text: '#475569', label: 'Inactive' },
  satisfied: { dot: '#6366F1', bg: '#EEF2FF', text: '#4338CA', label: 'Satisfied' },
  complete: { dot: '#3B82F6', bg: '#EFF6FF', text: '#1D4ED8', label: 'Complete' },
  incomplete: {
    dot: '#EAB308',
    bg: '#FEFCE8',
    text: '#854D0E',
    label: 'Incomplete',
  },
};

export function StatusPill({ status }: { status: Status }) {
  const s = MAP[status] ?? MAP.inactive;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11.5px] font-semibold"
      style={{ background: s.bg, color: s.text }}
    >
      <span
        className="relative w-1.5 h-1.5 rounded-full inline-block"
        style={{ color: s.dot, background: s.dot }}
      >
        {s.pulse && (
          <span
            className="absolute inset-0 rounded-full animate-pulse-dot"
            style={{ background: s.dot, opacity: 0.4 }}
          />
        )}
      </span>
      {s.label}
    </span>
  );
}
