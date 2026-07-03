'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type ButtonKind = 'primary' | 'ghost' | 'soft' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: ButtonKind;
  icon?: ReactNode;
}

const kindStyles: Record<ButtonKind, string> = {
  primary: 'bg-primary text-white hover:bg-primary-600 bd-shadow',
  ghost: 'bg-white text-ink-700 border border-[var(--bd-border)] hover:bg-ink-50',
  soft: 'bg-[var(--bd-primary-50)] text-primary-600 hover:bg-[var(--bd-primary-100)]',
  danger: 'bg-rose-50 text-rose-700 hover:bg-rose-100',
};

export function Button({
  kind = 'primary',
  children,
  icon,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[13.5px] font-medium transition-all',
        // Disabled state needs a visible cue — without it the button looks
        // clickable but the native `disabled` silently swallows the click.
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        kindStyles[kind],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
