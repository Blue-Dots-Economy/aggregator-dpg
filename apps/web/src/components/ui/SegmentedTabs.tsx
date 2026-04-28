'use client';

import type { ReactNode } from 'react';

export interface SegmentedTab<T extends string> {
  id: T;
  label: ReactNode;
}

interface SegmentedTabsProps<T extends string> {
  value: T;
  onChange: (id: T) => void;
  items: SegmentedTab<T>[];
  className?: string;
}

export function SegmentedTabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: SegmentedTabsProps<T>) {
  return (
    <div className={`seg ${className ?? ''}`}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={value === it.id ? 'active' : ''}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
