'use client';

/**
 * Status count card for the dashboard (`web` app).
 */
import type { ReactNode } from 'react';
import { I, type IconName } from '@/icons';
import { useThemeMode } from '@/lib/theme-mode';

/** Colour tone of a status card. */
export type StatTone = 'new' | 'active' | 'risk' | 'inactive' | 'satisfied';

interface StatToneConfig {
  ring: string;
  bg: string;
  icon: string;
  num: { light: string; dark: string };
}

const STAT_TONES: Record<StatTone, StatToneConfig> = {
  new: {
    ring: '#6EE7B7',
    bg: 'linear-gradient(180deg,var(--bd-tint-emerald) 0%,var(--bd-card) 70%)',
    icon: '#059669',
    num: { light: '#065F46', dark: '#6EE7B7' },
  },
  active: {
    ring: '#A7F3D0',
    bg: 'linear-gradient(180deg,var(--bd-tint-emerald) 0%,var(--bd-card) 70%)',
    icon: '#10B981',
    num: { light: '#047857', dark: '#34D399' },
  },
  risk: {
    ring: '#FCD34D',
    bg: 'linear-gradient(180deg,var(--bd-tint-amber) 0%,var(--bd-card) 70%)',
    icon: '#F59E0B',
    num: { light: '#B45309', dark: '#FBBF24' },
  },
  inactive: {
    ring: '#FCA5A5',
    bg: 'linear-gradient(180deg,var(--bd-tint-rose) 0%,var(--bd-card) 70%)',
    icon: '#EF4444',
    num: { light: '#B91C1C', dark: '#F87171' },
  },
  satisfied: {
    ring: '#C7D2FE',
    bg: 'linear-gradient(180deg,var(--bd-tint-primary) 0%,var(--bd-card) 70%)',
    icon: '#6366F1',
    num: { light: '#4338CA', dark: '#A5B4FC' },
  },
};

/** Props for {@link StatCard}. */
export interface StatCardProps {
  tone: StatTone;
  count: string;
  label: string;
  icon: IconName;
  hint?: string;
  action?: ReactNode;
}

/** Card with an icon, a large count, a label and an optional hint. */
export function StatCard({ tone, count, label, icon, hint, action }: StatCardProps) {
  const t = STAT_TONES[tone];
  const { mode } = useThemeMode();
  const Ic = I[icon];
  const numColor = mode === 'dark' ? t.num.dark : t.num.light;
  return (
    <div
      className="bd-card bd-shadow p-5 flex flex-col relative overflow-hidden transition-transform hover:-translate-y-0.5"
      style={{ background: t.bg }}
    >
      <div className="flex items-center justify-between mb-3.5">
        <div
          className="w-9 h-9 rounded-[10px] flex items-center justify-center"
          style={{ background: 'var(--bd-card)', border: `1px solid ${t.ring}`, color: t.icon }}
        >
          <Ic size={18} />
        </div>
        {action}
      </div>
      <div
        className="font-display font-bold text-[32px] leading-none tracking-tight"
        style={{ color: numColor }}
      >
        {count}
      </div>
      <div className="text-[15px] font-bold text-ink-900 mt-2.5">{label}</div>
      {hint && <div className="text-[12.5px] text-ink-500 mt-1 font-medium">{hint}</div>}
    </div>
  );
}
