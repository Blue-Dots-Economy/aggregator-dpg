import type { ReactNode } from 'react';

interface TopbarProps {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}

export function Topbar({ title, subtitle, right }: TopbarProps) {
  return (
    <div className="flex items-start justify-between gap-6 mb-6">
      <div>
        <h1 className="font-display font-bold text-[26px] text-ink-900 tracking-tight leading-tight">
          {title}
        </h1>
        {subtitle && <p className="text-[14px] text-ink-400 mt-1">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}
