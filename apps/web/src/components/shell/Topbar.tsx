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
    <div className="flex items-start justify-between gap-6 mb-6">
      <div>
        <h1 className="font-display font-bold text-[26px] text-ink-900 tracking-tight leading-tight">
          {title}
        </h1>
        {subtitle && <p className="text-[14px] text-ink-400 mt-1">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {right}
        <LanguageSwitcher />
        <button
          type="button"
          onClick={toggle}
          title={mode === 'dark' ? t('switch_to_light') : t('switch_to_dark')}
          aria-label={t('toggle_aria')}
          className="w-9 h-9 rounded-[10px] flex items-center justify-center border border-[var(--bd-border)] bg-[var(--bd-card)] text-[var(--bd-fg-muted)] hover:text-[var(--bd-fg)] hover:bg-[var(--bd-border-soft)] transition-colors"
        >
          {mode === 'dark' ? <I.sun size={16} /> : <I.moon size={16} />}
        </button>
      </div>
    </div>
  );
}
