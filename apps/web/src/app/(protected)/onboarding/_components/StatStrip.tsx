'use client';

import { useMemo } from 'react';
import { I } from '../../../../icons';
import { useOnboardingSummary } from '../../../../hooks/useOnboarding';

interface StatItem {
  icon: 'users' | 'shield' | 'alert' | 'refresh';
  label: string;
  count: number;
  tone: string;
  bg: string;
}

export function StatStrip() {
  const summary = useOnboardingSummary();
  const items: StatItem[] = useMemo(() => {
    const total = summary.data?.total ?? 0;
    const passed = summary.data?.passed ?? 0;
    const failed = summary.data?.failed ?? 0;
    return [
      {
        icon: 'users',
        label: 'Total registered',
        count: total,
        tone: '#6366F1',
        bg: 'var(--bd-tint-primary)',
      },
      {
        icon: 'shield',
        label: 'Verified & onboarded',
        count: passed,
        tone: '#10B981',
        bg: 'var(--bd-tint-emerald)',
      },
      {
        icon: 'alert',
        label: 'Failed validations',
        count: failed,
        tone: '#EF4444',
        bg: 'var(--bd-tint-rose)',
      },
    ];
  }, [summary.data]);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {items.map((it, i) => {
        const Ic = I[it.icon];
        return (
          <div key={i} className="bd-card bd-shadow px-4 py-3 flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0"
              style={{ background: it.bg, color: it.tone }}
            >
              <Ic size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="font-display font-bold text-[22px] leading-none tracking-tight"
                style={{ color: it.tone }}
              >
                {summary.isLoading ? '…' : it.count}
              </div>
              <div className="text-[12px] text-ink-500 mt-1">{it.label}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
