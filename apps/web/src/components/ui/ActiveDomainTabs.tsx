'use client';

/**
 * {@link DomainTabs} bound to the coordinator's active domain, so every page
 * that shows it switches the same choice.
 */

import type { JSX } from 'react';
import { useActiveDomain } from '@/hooks/useActiveDomain';
import { DomainTabs } from './DomainTabs';

/** Props for {@link ActiveDomainTabs}. */
export interface ActiveDomainTabsProps {
  /** Extra classes for the tab list. */
  className?: string;
}

/**
 * Renders the domain tabs for the active domain.
 *
 * @returns The tab list, or `null` for a single domain.
 */
export function ActiveDomainTabs({
  className,
}: Readonly<ActiveDomainTabsProps>): JSX.Element | null {
  const { domains, active, setActive } = useActiveDomain();
  return (
    <DomainTabs
      domains={domains}
      value={active}
      onChange={setActive}
      {...(className ? { className } : {})}
    />
  );
}
