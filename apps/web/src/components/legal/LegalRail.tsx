/**
 * The contents rail on the public legal page: one group per audience, each
 * with its documents and their sections as same-page anchors.
 */

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import { DOC_ORDER, type DocEntry, type LaidOutGroup } from './legal-layout';
import type { LegalSection } from './legal-sections';

/** Rail entry for one document's sections within an audience group. */
function RailSections({
  sections,
  activeSectionId,
  onNavigate,
}: Readonly<{
  sections: LegalSection[];
  activeSectionId: string | null;
  onNavigate: (id: string) => void;
}>) {
  if (sections.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {sections.map((section) => {
        const isActive = activeSectionId === section.id;
        return (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              aria-current={isActive ? 'true' : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(section.id);
              }}
              className={cn(
                'block rounded-md border-l-2 py-1 pl-3 text-[12.5px] transition-colors',
                isActive
                  ? 'border-(--bd-primary-600) bg-(--bd-primary-50) font-semibold text-(--bd-primary-600)'
                  : 'border-transparent text-ink-500 hover:bg-(--bd-border-soft) hover:text-ink-900',
              )}
            >
              {section.heading}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Renders one document in the rail: its title link and its section list.
 *
 * Document rows carry no "current" marker; only the section highlight from
 * the scroll-spy shows position. `sections` already have page-unique ids.
 */
function RailDocument({
  entry,
  headingId,
  sections,
  activeSectionId,
  onNavigate,
}: Readonly<{
  entry: DocEntry;
  headingId: string;
  sections: LegalSection[];
  activeSectionId: string | null;
  onNavigate: (id: string) => void;
}>) {
  return (
    <div className="mb-3">
      <a
        href={`#${headingId}`}
        onClick={(event) => {
          event.preventDefault();
          onNavigate(headingId);
        }}
        className="block rounded-md py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-500 transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-primary-600)"
      >
        {entry.title}
      </a>
      <RailSections sections={sections} activeSectionId={activeSectionId} onNavigate={onNavigate} />
    </div>
  );
}

/** The contents rail: audience groups, their documents and their sections. */
export function LegalRail({
  layout,
  activeSectionId,
  onNavigate,
}: Readonly<{
  layout: readonly LaidOutGroup[];
  activeSectionId: string | null;
  onNavigate: (id: string) => void;
}>) {
  const t = useTranslations('legal');
  return (
    <nav
      aria-label={t('contents_label')}
      // Sticks just under the app bar. Scrolls on its own because it is
      // taller than the viewport; `overscroll-contain` keeps that scroll
      // from moving the page.
      className="md:sticky md:top-14 md:max-h-[calc(100svh-3.5rem)] md:self-start md:overflow-y-auto md:overscroll-contain md:border-r md:border-(--bd-border) md:py-6 md:pr-6"
    >
      {layout.map((group) => (
        <div key={group.audience} className="mb-6">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-500">
            {group.label}
          </p>
          {DOC_ORDER.map((d) => (
            <RailDocument
              key={d}
              entry={group.docs[d].entry}
              headingId={group.docs[d].headingId}
              sections={group.docs[d].sections}
              activeSectionId={activeSectionId}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
