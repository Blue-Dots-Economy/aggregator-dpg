'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { I } from '../../icons';
import { useThemeMode } from '../../lib/theme-mode';
import { LanguageSwitcher } from './LanguageSwitcher';

interface TopbarProps {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}

export function Topbar({ title, subtitle, right }: TopbarProps) {
  const { mode, toggle } = useThemeMode();
  const t = useTranslations('theme');
  return (
    // Below `sm` the title block and the actions stack, and the actions wrap,
    // so a phone never overflows horizontally (#793).
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6 mb-6">
      <div className="min-w-0">
        <h1 className="font-display font-bold text-[26px] text-ink-900 tracking-tight leading-tight">
          {title}
        </h1>
        {subtitle && <p className="text-[14px] text-ink-400 mt-1">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
        {right}
        <LanguageSwitcher />
        <button
          type="button"
          onClick={toggle}
          title={mode === 'dark' ? t('switch_to_light') : t('switch_to_dark')}
          aria-label={t('toggle_aria')}
          className="w-9 h-9 rounded-[10px] flex items-center justify-center border border-(--bd-border) bg-(--bd-card) text-(--bd-fg-muted) hover:text-(--bd-fg) hover:bg-(--bd-border-soft) transition-colors"
        >
          {mode === 'dark' ? <I.sun size={16} /> : <I.moon size={16} />}
        </button>
      </div>
    </div>
  );
}
