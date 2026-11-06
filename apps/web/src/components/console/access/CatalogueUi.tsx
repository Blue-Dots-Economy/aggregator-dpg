/**
 * Small presentational pieces shared by the roles and permissions catalogue
 * tabs: chips, badges, pills, stats and the empty message.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A permission chip that opens it on the permissions tab. */
export function PermissionChip({
  permission,
  danger,
  hit,
  title,
  onOpen,
}: Readonly<{
  permission: string;
  danger: boolean;
  hit: boolean;
  title?: string | undefined;
  onOpen: (key: string) => void;
}>) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onOpen(permission)}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 font-mono text-[12px]',
        danger
          ? 'bg-rose-50 text-rose-700 hover:border-rose-200'
          : 'bg-(--bd-border-soft) text-ink-700 hover:border-(--bd-border) hover:bg-(--bd-card)',
        hit && 'outline-2 outline-offset-1 outline-(--bd-primary)',
      )}
    >
      {danger ? '● ' : ''}
      {permission}
    </button>
  );
}

/** A small rounded label. */
export function Badge({
  tone,
  children,
}: Readonly<{ tone: 'brand' | 'muted'; children: ReactNode }>) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10.5px] font-bold tracking-wide',
        tone === 'brand'
          ? 'bg-(--bd-primary-50) text-(--bd-primary-600)'
          : 'bg-(--bd-border-soft) text-ink-500',
      )}
    >
      {children}
    </span>
  );
}

/** A pill of role metadata. */
export function Meta({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-(--bd-border) bg-(--bd-bg) px-2.5 py-0.5 text-[12px] text-ink-500">
      {children}
    </span>
  );
}

/** A small number with its label. */
export function MiniStat({
  value,
  suffix,
  label,
  warn = false,
}: Readonly<{ value: string; suffix?: string; label: string; warn?: boolean }>) {
  return (
    <div className="rounded-[10px] border border-(--bd-border) bg-(--bd-bg) px-3 py-2.5">
      <b
        className={cn(
          'block font-display text-[18px] font-extrabold text-ink-900',
          warn && 'text-rose-600',
        )}
      >
        {value}
        {suffix ? <span className="text-[12px] font-semibold text-ink-500">{suffix}</span> : null}
      </b>
      <span className="text-[11.5px] text-ink-500">{label}</span>
    </div>
  );
}

/** A plain empty or no-match message. */
export function Empty({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="bd-card bd-shadow px-6 py-12 text-center text-ink-500">{children}</div>;
}
