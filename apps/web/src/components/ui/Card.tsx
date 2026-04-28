import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  shadow?: 'sm' | 'lg' | 'none';
}

export function Card({ className, children, shadow = 'sm', ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'bd-card',
        shadow === 'sm' && 'bd-shadow',
        shadow === 'lg' && 'bd-shadow-lg',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
