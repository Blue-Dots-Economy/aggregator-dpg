'use client';

import type { ReactNode } from 'react';
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitcher } from './LanguageSwitcher';

interface TopbarProps {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}

export function Topbar({ title, subtitle, right }: TopbarProps) {
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
        <ThemeToggle />
      </div>
    </div>
  );
}
