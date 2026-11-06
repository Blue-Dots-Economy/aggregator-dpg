'use client';
/**
 * Read-only public legal page at `/legal`.
 *
 * Shows each audience's Privacy Policy and Terms of Service in one scroll,
 * with a contents rail beside the reading column. `/privacy` and `/terms`
 * redirect to `/legal#privacy` and `/legal#terms`.
 *
 * Every rail entry is a same-page anchor. The rail is grouped by audience,
 * then document, then section, and the reading column follows the same order.
 *
 * This page captures no consent; that is done by `ConsentGate`.
 *
 * @module apps/web/src/components/legal/LegalDocumentView
 */
import { useMemo, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import { layOutLegalPage, type LegalGroup } from './legal-layout';
import { LegalAppBar } from './LegalAppBar';
import { LegalRail } from './LegalRail';
import { LegalReadingColumn } from './LegalReadingColumn';
import { useLegalScrollSpy } from './useLegalScrollSpy';

export type { LegalDoc, LegalGroup } from './legal-layout';

/**
 * Renders the `/legal` page: app bar, contents rail, and all documents.
 *
 * The URL fragment decides where the reader lands.
 *
 * @param props.groups - One entry per audience whose content loaded.
 * @returns The legal page, or an "unavailable" message when `groups` is empty.
 */
export function LegalDocumentView({
  groups,
}: Readonly<{
  groups: LegalGroup[];
}>): JSX.Element {
  const t = useTranslations('legal');
  // Laid out once; the rail, the reading column and the scroll-spy share it so their ids match.
  const layout = useMemo(() => layOutLegalPage(groups), [groups]);
  const { activeSectionId, navigateTo } = useLegalScrollSpy(layout);

  if (groups.length === 0) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-(--bd-bg) px-6 py-12">
        {/* `<output>` has the implicit `status` role. */}
        <output className="text-sm text-ink-500">{t('unavailable')}</output>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-(--bd-bg)">
      <LegalAppBar />
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="grid gap-8 md:grid-cols-[240px_1fr] md:gap-10">
          <LegalRail layout={layout} activeSectionId={activeSectionId} onNavigate={navigateTo} />
          <LegalReadingColumn layout={layout} />
        </div>
      </div>
    </div>
  );
}
