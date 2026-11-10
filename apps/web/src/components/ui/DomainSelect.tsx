'use client';

/**
 * Domain dropdown for coordinators who serve more than one domain, in `apps/web`.
 *
 * Renders nothing for a coordinator with a single domain, so their screens
 * look the same as before. Uses the shared `Select`, styled like the language
 * switcher.
 */

import type { JSX } from 'react';
import { useTranslations } from 'next-intl';
import { Tag } from 'lucide-react';
import type { AggregatorConfigDomain } from '@/hooks/useAggregatorConfig';
import { cn } from '@/lib/cn';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select';

export interface DomainSelectProps {
  /** The domains to choose from, in display order. */
  domains: readonly AggregatorConfigDomain[];
  /** The selected domain id. */
  value: string | undefined;
  /** Called with the chosen domain id. */
  onChange: (id: string) => void;
  /** Extra classes for the trigger, such as `w-full` inside a form. */
  className?: string;
}

/**
 * Lets the coordinator switch the domain a screen acts on.
 *
 * @returns The dropdown, or `null` when there is nothing to choose.
 */
export function DomainSelect({
  domains,
  value,
  onChange,
  className,
}: Readonly<DomainSelectProps>): JSX.Element | null {
  const t = useTranslations('common');
  if (domains.length < 2) return null;
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger
        aria-label={t('domain_label')}
        className={cn('w-auto gap-1.5 px-2.5 py-2', className)}
      >
        {/* Keeps the icon and value together on the left; the trigger spreads its children apart. */}
        <div className="flex min-w-0 items-center gap-2 truncate">
          <Tag className="h-4 w-4 shrink-0 text-(--bd-primary-600)" aria-hidden="true" />
          <SelectValue />
        </div>
      </SelectTrigger>
      <SelectContent align="end">
        {domains.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.plural_label || d.label || d.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
