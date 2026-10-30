'use client';

/**
 * The domains a coordinator serves, as chips with the Signals domain icons.
 */

import { getDomainIcon } from '../../lib/domain-icons';

/** One served domain. */
export interface ServedDomain {
  id: string;
  label: string;
}

/** The domains a coordinator serves as chips. */
export function DomainChips({
  domains,
  networkId,
}: Readonly<{ domains: ServedDomain[]; networkId: string | null }>) {
  if (domains.length === 0) return <span className="text-ink-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {domains.map((d) => {
        const Icon = getDomainIcon(d.id, networkId);
        return (
          <span
            key={d.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-(--bd-border) bg-(--bd-card) px-2.5 py-1 text-[12px] font-semibold text-ink-700"
          >
            <Icon size={13} aria-hidden="true" className="text-(--bd-primary-600)" />
            {d.label}
          </span>
        );
      })}
    </div>
  );
}
