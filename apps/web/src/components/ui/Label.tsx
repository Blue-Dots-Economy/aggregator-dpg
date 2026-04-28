import type { LabelHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
}

export function Label({ className, children, ...rest }: LabelProps) {
  return (
    <label className={cn('bd-label', className)} {...rest}>
      {children}
    </label>
  );
}
