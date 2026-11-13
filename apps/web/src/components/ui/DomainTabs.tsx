'use client';

/**
 * Domain tabs for coordinators who serve more than one domain, in `apps/web`.
 *
 * Renders nothing for a single domain.
 */

import { useRef, type JSX, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { AggregatorConfigDomain } from '../../hooks/useAggregatorConfig';
import { cn } from '../../lib/cn';

export interface DomainTabsProps {
  /** The domains to choose from, in display order. */
  domains: readonly AggregatorConfigDomain[];
  /** The selected domain id. */
  value: string | undefined;
  /** Called with the chosen domain id. */
  onChange: (id: string) => void;
  /** Participant count per domain id; a domain without one shows no count. */
  counts?: Readonly<Record<string, number | undefined>>;
  /** Extra classes for the tab list. */
  className?: string;
}

/**
 * Lets the coordinator switch the domain a screen shows.
 *
 * Arrow keys, Home and End move between tabs, following the WAI-ARIA tabs pattern.
 *
 * @returns The tab list, or `null` when there is nothing to choose.
 */
export function DomainTabs({
  domains,
  value,
  onChange,
  counts,
  className,
}: Readonly<DomainTabsProps>): JSX.Element | null {
  const t = useTranslations('common');
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  if (domains.length < 2) return null;

  const select = (index: number) => {
    const domain = domains[index];
    if (!domain) return;
    onChange(domain.id);
    tabs.current[index]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const current = domains.findIndex((d) => d.id === value);
    const last = domains.length - 1;
    const next: Record<string, number> = {
      ArrowRight: current >= last ? 0 : current + 1,
      ArrowLeft: current <= 0 ? last : current - 1,
      Home: 0,
      End: last,
    };
    const target = next[e.key];
    if (target === undefined) return;
    e.preventDefault();
    select(target);
  };

  return (
    <div
      role="tablist"
      aria-label={t('domain_label')}
      className={cn(
        'flex gap-1 overflow-x-auto border-b border-(--bd-border) [scrollbar-width:none]',
        className,
      )}
    >
      {domains.map((d, i) => {
        const selected = d.id === value;
        const count = counts?.[d.id];
        return (
          <button
            key={d.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(d.id)}
            onKeyDown={onKeyDown}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-[2.5px] px-4 pt-2 pb-2.5 text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--bd-primary-50)] rounded-t-[8px]',
              selected
                ? 'border-(--bd-primary) text-(--bd-primary-600)'
                : 'border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-900',
            )}
          >
            {d.plural_label || d.label || d.id}
            {/* Separates label and count in the tab's accessible name; flex layout does not render it. */}
            {count === undefined ? null : ' '}
            {count === undefined ? null : (
              <span
                className={cn(
                  'min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11.5px] font-bold tabular-nums',
                  selected
                    ? 'bg-(--bd-primary-50) text-(--bd-primary-600)'
                    : 'bg-ink-100 text-ink-500',
                )}
              >
                {count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
