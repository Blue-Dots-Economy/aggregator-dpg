'use client';

/**
 * Domain dropdown for coordinators who serve more than one domain, in `apps/web`.
 *
 * Renders nothing for a coordinator with a single domain, so their screens
 * look the same as before.
 */

import type { JSX } from 'react';
import { useTranslations } from 'next-intl';
import type { AggregatorConfigDomain } from '../../hooks/useAggregatorConfig';
import { cn } from '../../lib/cn';

export interface DomainSelectProps {
  /** The domains to choose from, in display order. */
  domains: readonly AggregatorConfigDomain[];
  /** The selected domain id. */
  value: string | undefined;
  /** Called with the chosen domain id. */
  onChange: (id: string) => void;
  /** Extra classes for the `<select>`. */
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
    <select
      aria-label={t('domain_label')}
      className={cn('bd-input w-auto text-[13px] py-1.5 pr-7', className)}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {domains.map((d) => (
        <option key={d.id} value={d.id}>
          {d.plural_label || d.label || d.id}
        </option>
      ))}
    </select>
  );
}
